"""Text chat with a published agent, for visitors on a website.

It is the same agent as on the phone: the same compiled instructions, rules and tools (take a
message, send a booking link, request an appointment), run by a text model instead of a voice
model. Chat costs a small fraction of a voice call, and some people simply prefer to type.

It talks to OpenAI's Responses API (the one the current models take tool calls through). Each turn
sends only what is new and points at the previous response, so the long instructions are read from
cache rather than paid for again.

A chat is kept in the database between messages (see ``chat_store``), so any copy of the server can
carry on a chat another copy started, and a restart or a deploy loses nothing. When the visitor
ends it, or goes quiet for a few minutes, it is finished the way a call is: summarized, saved
under Calls (marked as a chat), sent to Votel, and noted on the client's contact. Exactly one copy
finishes each chat. Nothing in a chat can place a call or reach anything the agent's tools cannot
reach.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

import aiohttp
from livekit.agents.llm import ChatContext, ToolError

from . import embed
from .adapters import Adapter, restore_adapters, snapshot_adapters
from .chat_store import ChatStore, default_store
from .compiler import CompiledAgent, compile_agent
from .finish_queue import finish_call
from .knowledge import Knowledge, Searcher, apply_knowledge, knowledge_tools, load_knowledge
from .loader import LoadedConfig, published_source
from .redact import redact_text
from .tools import CallRecorder, build_tools

log = logging.getLogger("agent_builder.chat")

DEFAULT_MODEL = "gpt-6-luna"
MAX_USER_CHARS = 1000
MAX_USER_TURNS = 40
MAX_TOOL_ROUNDS = 4
MAX_SESSIONS = 300
IDLE_SECONDS = 180.0
SWEEP_EVERY_S = 30.0
FINISH_TRIES = 10
"""How many times a quiet chat is tried for finishing before it is given up on."""
SORRY = "Sorry, I had trouble with that. Could you say it another way?"

CHAT_RULES = """# This is a text chat
You are chatting by text with a visitor on the business's website. You are not on the phone.
- "Call" and "caller" in the instructions above mean this chat and the visitor.
- The opening greeting has already been shown, so never repeat it.
- Reply in plain text: no markdown or bullet symbols. One to three short sentences at a time.
- You cannot hear them and they cannot hear you. Never say you are listening.
- You do not know their phone number. Ask for it when you need it, and write it back the usual way (512-555-0100), never digit by digit, to confirm.
- A live chat cannot be put through to a person. If someone needs a person, take a message and
  say the team will follow up.
- When they are done, say a short goodbye and stop asking questions."""


class ChatError(Exception):
    """A chat could not start or continue. ``code`` is what the website shows a reason for."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def chat_instructions(compiled: CompiledAgent, backend_flows: str) -> str:
    flows = f"# Backend flows\n{backend_flows.strip()}" if backend_flows.strip() else ""
    return "\n\n".join(p for p in (compiled.voice_instructions, flows, CHAT_RULES) if p)


def tool_specs(tools: list[Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The agent's tools by name, and the same tools in the shape the Responses API takes."""
    by_name: dict[str, Any] = {}
    specs = []
    for t in tools:
        raw = t.info.raw_schema
        by_name[raw["name"]] = t
        specs.append(
            {
                "type": "function",
                "name": raw["name"],
                "description": raw.get("description", ""),
                "parameters": raw.get("parameters", {"type": "object", "properties": {}}),
            }
        )
    return by_name, specs


@dataclass
class Session:
    id: str
    loaded: LoadedConfig
    compiled: CompiledAgent
    instructions: str
    tools: dict[str, Any]
    specs: list[dict[str, Any]]
    adapters: dict[str, Adapter]
    recorder: CallRecorder
    started_at: float
    last_at: float
    transcript: list[tuple[str, str]]  # ("assistant" | "user", text)
    last_id: str | None = None
    """The model's previous response; the next turn continues from it."""
    turns: int = 0
    finish_tries: int = 0


def _text_of(output: list[dict[str, Any]]) -> str:
    """What the model said, from a response's output items."""
    parts = []
    for item in output:
        if item.get("type") == "message":
            for c in item.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    parts.append(str(c.get("text") or ""))
    return "".join(parts).strip()


Finish = Callable[[LoadedConfig, dict[str, Any]], Awaitable[None]]
Load = Callable[[str], Awaitable[LoadedConfig]]
LoadKnowledge = Callable[[str | None], Awaitable[Knowledge | None]]


class ChatService:
    """Runs website chats. The database holds each chat's state; ``sessions`` is only a cache of the
    chats this copy has handled lately, so it may be behind and is checked on every message."""

    def __init__(
        self,
        *,
        finish: Finish = finish_call,
        load: Load | None = None,
        begin: Callable[[str, str], Awaitable[str]] = embed.begin,
        store: ChatStore | None = None,
        knowledge: LoadKnowledge = load_knowledge,
        searcher: Searcher | None = None,
        key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        idle_seconds: float = IDLE_SECONDS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._finish = finish
        self._load = load or (lambda agent_id: published_source().load(agent_id))
        self._begin = begin
        self._store = store or default_store()
        self._knowledge = knowledge
        self._searcher = searcher
        self._key = key
        self._base = base_url
        self._model = model
        self._idle = idle_seconds
        self._clock = clock
        self._effort: str | None = os.getenv("CHAT_REASONING_EFFORT", "low") or None
        self.sessions: dict[str, Session] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    # --- building and saving a session -------------------------------------------------------

    def _build(
        self,
        loaded: LoadedConfig,
        session_id: str,
        saved: dict[str, Any] | None,
        knowledge: Knowledge | None = None,
    ) -> Session:
        """A session for ``loaded``, fresh or restored from what the database holds."""
        cfg = loaded.config
        compiled = apply_knowledge(compile_agent(cfg, now=datetime.now(UTC)), knowledge)
        recorder = CallRecorder()
        tools, adapters = build_tools(
            cfg, compiled, recorder, caller=lambda: None, account_id=loaded.account_id
        )
        tools.extend(knowledge_tools(loaded.agent_id, knowledge, recorder, self._searcher))
        by_name, specs = tool_specs(tools)
        now = self._clock()
        s = Session(
            id=session_id,
            loaded=loaded,
            compiled=compiled,
            instructions=chat_instructions(compiled, cfg.policy.backend_flows),
            tools=by_name,
            specs=specs,
            adapters=adapters,
            recorder=recorder,
            started_at=now,
            last_at=now,
            transcript=[("assistant", compiled.opening_line)],
        )
        if saved:
            s.started_at = float(saved.get("started_at", now))
            s.last_at = float(saved.get("last_at", now))
            s.last_id = saved.get("last_id") or None
            s.turns = int(saved.get("turns", 0))
            s.finish_tries = int(saved.get("finish_tries", 0))
            s.transcript = [(str(r), str(t)) for r, t in saved.get("transcript", [])]
            rec = saved.get("recorder") or {}
            recorder.restore(
                rec.get("calls", []), bool(rec.get("transferred")), rec.get("transfer_reason")
            )
            restore_adapters(adapters, saved.get("adapter_state") or {})
        return s

    @staticmethod
    def _state(s: Session) -> dict[str, Any]:
        return {
            "agent_id": s.loaded.agent_id,
            "version_id": s.loaded.version_id,
            "version": s.loaded.version,
            "fingerprint": s.compiled.fingerprint,
            "started_at": s.started_at,
            "last_at": s.last_at,
            "last_id": s.last_id,
            "turns": s.turns,
            "finish_tries": s.finish_tries,
            "transcript": [[r, t] for r, t in s.transcript],
            "recorder": {
                "calls": s.recorder.to_json(),
                "transferred": s.recorder.transferred,
                "transfer_reason": s.recorder.transfer_reason,
            },
            "adapter_state": snapshot_adapters(s.adapters),
        }

    async def _save(self, s: Session) -> None:
        """Write the chat's state. A failure is logged and tried again after the next message."""
        try:
            await self._store.save(s.id, str(s.loaded.agent_id), self._state(s), s.last_at)
        except Exception:
            log.exception("could not save the chat state")

    def _lock(self, session_id: str) -> asyncio.Lock:
        return self._locks.setdefault(session_id, asyncio.Lock())

    async def _open(self, session_id: str) -> Session | None:
        """The open chat with this id, brought up to date from the database. None if it is over."""
        cached = self.sessions.get(session_id)
        try:
            saved = await self._store.load(session_id)
        except Exception as e:
            if cached is not None:
                log.warning("chat state unreachable; carrying on from memory: %s", e)
                return cached
            log.exception("could not read the chat state")
            raise ChatError("try_again") from e
        if saved is None:
            self.sessions.pop(session_id, None)
            return None
        if (
            cached is not None
            and cached.turns == int(saved.get("turns", 0))
            and cached.last_id == (saved.get("last_id") or None)
        ):
            return cached  # nothing happened elsewhere since this copy last saw it
        agent_id = str(saved.get("agent_id") or "")
        try:
            loaded = await self._load(agent_id)
        except LookupError as e:
            raise ChatError("unpublished") from e
        except (aiohttp.ClientError, TimeoutError, RuntimeError) as e:
            raise ChatError("try_again") from e
        s = self._build(loaded, session_id, saved, await self._knowledge(loaded.agent_id))
        self.sessions[session_id] = s
        return s

    # --- starting ---------------------------------------------------------------------------

    async def start(self, agent_id: str) -> tuple[str, str]:
        """Count one chat against the agent's daily cap, and open it. Returns (session id, greeting)."""
        if len(self.sessions) >= MAX_SESSIONS:
            raise ChatError("busy")
        try:
            status = await self._begin(agent_id, "chat")
        except embed.EmbedError as e:
            raise ChatError("try_again") from e
        if status != "ok":
            raise ChatError(status)
        try:
            loaded = await self._load(agent_id)
        except LookupError as e:
            raise ChatError("unpublished") from e
        except (aiohttp.ClientError, TimeoutError, RuntimeError) as e:
            raise ChatError("try_again") from e

        session = self._build(
            loaded, uuid.uuid4().hex, None, await self._knowledge(loaded.agent_id)
        )
        self.sessions[session.id] = session
        await self._save(session)
        return session.id, session.compiled.opening_line

    # --- one message ------------------------------------------------------------------------

    async def send(self, session_id: str, text: str) -> str:
        text = " ".join(text.split())  # one line, no stray whitespace
        async with self._lock(session_id):
            s = await self._open(session_id)
            if s is None:
                self._locks.pop(session_id, None)
                raise ChatError("gone")
            if not text:
                raise ChatError("empty")
            if len(text) > MAX_USER_CHARS:
                raise ChatError("too_long")
            if s.turns >= MAX_USER_TURNS:
                raise ChatError("limit")
            before = (s.last_id, s.turns, len(s.transcript), s.recorder.to_json())
            s.turns += 1
            s.transcript.append(("user", redact_text(text)))
            try:
                reply = await self._reply(s, text)
            except ChatError:
                s.last_id, s.turns = before[0], before[1]
                del s.transcript[before[2] :]
                raise
            s.transcript.append(("assistant", redact_text(reply)))
            s.last_at = self._clock()
            await self._save(s)
        return reply

    async def _reply(self, s: Session, text: str) -> str:
        # The first turn also hands over the greeting the visitor was shown, so the model knows it.
        items: list[dict[str, Any]] = (
            [{"role": "assistant", "content": s.compiled.opening_line}] if s.last_id is None else []
        )
        items.append({"role": "user", "content": text})
        for _ in range(MAX_TOOL_ROUNDS + 1):
            response = await self._respond(s, items)
            s.last_id = str(response["id"])
            output = [o for o in response.get("output") or [] if isinstance(o, dict)]
            calls = [o for o in output if o.get("type") == "function_call"]
            if not calls:
                return _text_of(output) or SORRY
            items = [
                {
                    "type": "function_call_output",
                    "call_id": c["call_id"],
                    "output": await self._run_tool(s, c),
                }
                for c in calls
            ]
        return SORRY

    async def _run_tool(self, s: Session, fn: dict[str, Any]) -> str:
        tool = s.tools.get(str(fn.get("name")))
        if tool is None:
            return "Error: no such tool."
        try:
            args = json.loads(fn.get("arguments") or "{}")
            if not isinstance(args, dict):
                raise TypeError
        except (ValueError, TypeError):
            return "Error: the arguments were not valid."
        try:
            return str(await tool(args, None))
        except ToolError as e:
            return f"Error: {e}"
        except Exception:  # a tool bug must not end the chat
            log.exception("chat tool %s crashed", fn.get("name"))
            return "Error: that did not work."

    async def _respond(self, s: Session, items: list[dict[str, Any]]) -> dict[str, Any]:
        key = self._key or os.getenv("OPENAI_API_KEY", "")
        if not key:
            raise ChatError("try_again")
        base = (self._base or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip(
            "/"
        )
        body: dict[str, Any] = {
            "model": self._model or os.getenv("CHAT_MODEL") or DEFAULT_MODEL,
            "instructions": s.instructions,
            "input": items,
            "max_output_tokens": 1500,
        }
        if s.specs:
            body["tools"] = s.specs
        if s.last_id:
            body["previous_response_id"] = s.last_id
        for attempt in (0, 1):
            if self._effort:
                body["reasoning"] = {"effort": self._effort}
            else:
                body.pop("reasoning", None)
            try:
                async with (
                    aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45)) as http,
                    http.post(
                        f"{base}/responses",
                        json=body,
                        headers={"Authorization": f"Bearer {key}"},
                    ) as r,
                ):
                    if r.status == 400 and self._effort and attempt == 0:
                        # A model that does not take reasoning settings: stop sending them.
                        log.warning("chat model refused the reasoning setting; retrying without it")
                        self._effort = None
                        continue
                    if r.status >= 300:
                        log.warning("chat model said HTTP %s: %s", r.status, (await r.text())[:300])
                        raise ChatError("try_again")
                    data = await r.json()
            except (aiohttp.ClientError, TimeoutError, ValueError) as e:
                log.warning("chat model unreachable: %s", e)
                raise ChatError("try_again") from e
            if not isinstance(data, dict) or not data.get("id") or data.get("error"):
                raise ChatError("try_again")
            return data
        raise ChatError("try_again")

    # --- finishing --------------------------------------------------------------------------

    async def end(self, session_id: str) -> bool:
        """Finish a chat now (the visitor left). False if it was already over."""
        self.sessions.pop(session_id, None)
        self._locks.pop(session_id, None)
        try:
            saved = await self._store.claim(session_id)
        except Exception:
            log.exception("could not finish the chat: the database is unreachable")
            return False
        if saved is None:
            return False
        await self._finish_saved(session_id, saved)
        return True

    async def _finish_saved(self, session_id: str, saved: dict[str, Any]) -> None:
        """Turn a finished chat's saved state into a call record and hand it to the retry queue."""
        if int(saved.get("turns", 0)) == 0:
            return  # opened and never used: nothing to save
        agent_id = str(saved.get("agent_id") or "")
        try:
            loaded = await self._load(agent_id)
        except (LookupError, aiohttp.ClientError, TimeoutError, RuntimeError) as e:
            log.warning("could not load agent %s to finish chat %s: %s", agent_id, session_id, e)
            await self._reopen(session_id, saved)
            return
        if saved.get("version_id") and saved["version_id"] != loaded.version_id:
            # Republished since the chat began: it is recorded against the version it ran on.
            loaded = replace(loaded, version_id=saved["version_id"], version=saved.get("version"))
        chat = ChatContext.empty()
        for role, text in saved.get("transcript", []):
            chat.add_message(role=role, content=text)  # type: ignore[arg-type]
        rec = saved.get("recorder") or {}
        started = float(saved.get("started_at", self._clock()))
        last = float(saved.get("last_at", started))
        calls = rec.get("calls", [])
        record = {
            "room": f"web-chat-{session_id}",
            "started_at": started,
            "duration_s": max(0.0, last - started),
            "goal_reached": any(c.get("goal") and c.get("ok") for c in calls),
            "transferred": bool(rec.get("transferred")),
            "transfer_reason": rec.get("transfer_reason"),
            "recoveries": 0,
            "voice_model": {
                "model": self._model or os.getenv("CHAT_MODEL") or DEFAULT_MODEL,
                "channel": "chat",
            },
            "config_fingerprint": saved.get("fingerprint"),
            "tool_calls": calls,
            "transcript": chat.to_dict(),
        }
        try:
            await self._finish(loaded, record)
        except Exception:
            log.exception("finishing the chat failed")

    async def _reopen(self, session_id: str, saved: dict[str, Any]) -> None:
        """A chat that could not be finished yet goes back to waiting, for a limited number of tries."""
        tries = int(saved.get("finish_tries", 0)) + 1
        if tries >= FINISH_TRIES:
            log.error("giving up on finishing chat %s", session_id)
            return
        try:
            await self._store.save(
                session_id,
                str(saved.get("agent_id") or ""),
                {**saved, "finish_tries": tries},
                float(saved.get("last_at", 0)),
            )
            await self._store.reopen(session_id)
        except Exception:
            log.exception("could not put chat %s back to wait", session_id)

    async def sweep(self) -> int:
        """Finish chats whose visitor went quiet, whichever copy of the server they were on.
        Every copy runs this; the database hands each quiet chat to exactly one. Returns how many."""
        finished = 0
        try:
            claimed = await self._store.claim_idle(self._idle)
        except Exception:
            log.exception("looking for quiet chats failed")
            claimed = []
        for sid, saved in claimed:
            self.sessions.pop(sid, None)
            self._locks.pop(sid, None)
            await self._finish_saved(sid, saved)
            finished += 1
        # Forget chats another copy finished, so this copy's memory does not grow.
        cutoff = self._clock() - self._idle - 60
        for sid, s in list(self.sessions.items()):
            if s.last_at < cutoff:
                self.sessions.pop(sid, None)
                self._locks.pop(sid, None)
        return finished

    async def run_sweeper(self, every_s: float = SWEEP_EVERY_S) -> None:
        while True:
            try:
                await self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("sweeping quiet chats failed")
            await asyncio.sleep(every_s)

    async def close(self) -> None:
        """The server is stopping. Chats kept in the database carry on elsewhere and are finished when
        they go quiet; chats held only in memory are finished now, or they would be lost."""
        if self._store.durable:
            return
        for sid in list(self.sessions):
            await self.end(sid)
