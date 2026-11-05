"""Text chat with a published agent, for visitors on a website.

It is the same agent as on the phone: the same compiled instructions, rules and tools (take a
message, send a booking link, request an appointment), run by a text model instead of a voice
model. Chat costs a small fraction of a voice call, and some people simply prefer to type.

It talks to OpenAI's Responses API (the one the current models take tool calls through). Each turn
sends only what is new and points at the previous response, so the long instructions are read from
cache rather than paid for again.

A chat lives in memory while it is going. When the visitor ends it, or goes quiet for a few
minutes, it is finished the way a call is: summarized, saved under Calls (marked as a chat),
sent to Votel, and noted on the client's contact. Nothing in a chat can place a call or reach
anything the agent's tools cannot reach.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import aiohttp
from livekit.agents.llm import ChatContext, ToolError

from . import embed
from .call_finish import after_call
from .compiler import CompiledAgent, compile_agent
from .loader import LoadedConfig, published_source
from .tools import CallRecorder, build_tools

log = logging.getLogger("agent_builder.chat")

DEFAULT_MODEL = "gpt-6-luna"
MAX_USER_CHARS = 1000
MAX_USER_TURNS = 40
MAX_TOOL_ROUNDS = 4
MAX_SESSIONS = 300
IDLE_SECONDS = 180.0
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
    recorder: CallRecorder
    started_at: float
    last_at: float
    transcript: list[tuple[str, str]]  # ("assistant" | "user", text)
    last_id: str | None = None
    """The model's previous response; the next turn continues from it."""
    turns: int = 0
    ended: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    idle: asyncio.TimerHandle | None = None


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


class ChatService:
    def __init__(
        self,
        *,
        finish: Finish = after_call,
        load: Load | None = None,
        begin: Callable[[str, str], Awaitable[str]] = embed.begin,
        key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        idle_seconds: float = IDLE_SECONDS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._finish = finish
        self._load = load or (lambda agent_id: published_source().load(agent_id))
        self._begin = begin
        self._key = key
        self._base = base_url
        self._model = model
        self._idle = idle_seconds
        self._clock = clock
        self._effort: str | None = os.getenv("CHAT_REASONING_EFFORT", "low") or None
        self.sessions: dict[str, Session] = {}
        self._tasks: set[asyncio.Task[None]] = set()

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

        cfg = loaded.config
        compiled = compile_agent(cfg, now=datetime.now(UTC))
        recorder = CallRecorder()
        tools, _ = build_tools(cfg, compiled, recorder, caller=lambda: None)
        by_name, specs = tool_specs(tools)
        now = self._clock()
        session = Session(
            id=uuid.uuid4().hex,
            loaded=loaded,
            compiled=compiled,
            instructions=chat_instructions(compiled, cfg.policy.backend_flows),
            tools=by_name,
            specs=specs,
            recorder=recorder,
            started_at=now,
            last_at=now,
            transcript=[("assistant", compiled.opening_line)],
        )
        self.sessions[session.id] = session
        self._arm_idle(session)
        return session.id, compiled.opening_line

    # --- one message ------------------------------------------------------------------------

    async def send(self, session_id: str, text: str) -> str:
        s = self.sessions.get(session_id)
        if s is None or s.ended:
            raise ChatError("gone")
        text = " ".join(text.split())  # one line, no stray whitespace
        if not text:
            raise ChatError("empty")
        if len(text) > MAX_USER_CHARS:
            raise ChatError("too_long")
        async with s.lock:
            if s.ended:
                raise ChatError("gone")
            if s.turns >= MAX_USER_TURNS:
                raise ChatError("limit")
            before = s.last_id
            s.turns += 1
            s.transcript.append(("user", text))
            try:
                reply = await self._reply(s, text)
            except ChatError:
                s.last_id = before
                s.transcript.pop()
                s.turns -= 1
                raise
            s.transcript.append(("assistant", reply))
            s.last_at = self._clock()
            self._arm_idle(s)
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

    def _arm_idle(self, s: Session) -> None:
        if s.idle:
            s.idle.cancel()
        loop = asyncio.get_running_loop()
        s.idle = loop.call_later(self._idle, self._idle_fired, s.id)

    def _idle_fired(self, session_id: str) -> None:
        task = asyncio.get_running_loop().create_task(self.end(session_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def end(self, session_id: str) -> bool:
        """Finish a chat now (the visitor left, or went quiet). False if it was already over."""
        s = self.sessions.pop(session_id, None)
        if s is None or s.ended:
            return False
        s.ended = True
        if s.idle:
            s.idle.cancel()
        if s.turns == 0:
            return True  # opened and never used: nothing to save
        chat = ChatContext.empty()
        for role, text in s.transcript:
            chat.add_message(role=role, content=text)  # type: ignore[arg-type]
        record = {
            "room": f"web-chat-{s.id}",
            "started_at": s.started_at,
            "duration_s": max(0.0, s.last_at - s.started_at),
            "goal_reached": s.recorder.goal_reached,
            "transferred": s.recorder.transferred,
            "transfer_reason": s.recorder.transfer_reason,
            "recoveries": 0,
            "voice_model": {
                "model": self._model or os.getenv("CHAT_MODEL") or DEFAULT_MODEL,
                "channel": "chat",
            },
            "config_fingerprint": s.compiled.fingerprint,
            "tool_calls": s.recorder.to_json(),
            "transcript": chat.to_dict(),
        }
        try:
            await self._finish(s.loaded, record)
        except Exception:
            log.exception("finishing the chat failed")
        return True

    async def close(self) -> None:
        """Finish every open chat (the server is stopping)."""
        for sid in list(self.sessions):
            await self.end(sid)
