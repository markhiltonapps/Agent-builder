"""LiveKit worker: one shared fleet, config loaded per call.

Run locally:  uv run agent-builder dev      (then talk to it in the LiveKit Agents Playground)

Memory rule: the worker owns the conversation, not the model session. Every turn is saved
per room. If the model session dies while the caller is still on the line, the worker starts
a new session seeded with that conversation and a resume note instead of the greeting. A new
job for a room with a live saved call (a worker restart that re-dispatches the room) resumes
the same way.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    ChatContext,
    CloseEvent,
    CloseReason,
    JobContext,
    cli,
)
from livekit.agents.beta.tools import EndCallTool

from .adapters import restore_adapters, snapshot_adapters
from .call_finish import after_call
from .compiler import CompiledAgent, compile_agent
from .loader import ROOT, resolve_config
from .preflight import run as run_preflight
from .providers import build_voice_model
from .session_store import ConversationStore, SavedCall, Saver, store_from_env
from .tools import CallRecorder, build_tools

load_dotenv(ROOT / ".env")
log = logging.getLogger("agent_builder")

CALL_LOG_DIR = Path(os.getenv("CALL_LOG_DIR", ROOT / "call_logs"))
CONVERSATION_DIR = ROOT / "conversations"

MAX_RESTARTS = 2
"""Fresh sessions per call after a model error, before the worker gives up."""
RESTART_BACKOFF_S = (0.5, 2.0)


def resume_instructions(completed: str) -> str:
    """What the model is told when a session picks up a call already in progress."""
    text = (
        "The call was briefly interrupted and you are back on the line with the same caller. "
        "Do not greet them or introduce yourself again. Say one short sentence such as "
        '"Sorry about that, I\'m back," then continue exactly where the conversation left '
        "off. If you had just asked a question, ask it again briefly."
    )
    if completed:
        text += (
            "\n\nAlready done on this call; do not repeat these actions, and use these "
            "results if the caller asks:\n" + completed
        )
    return text


class BuilderAgent(Agent):
    def __init__(
        self,
        compiled: CompiledAgent,
        tools: list,
        *,
        chat_ctx: ChatContext | None = None,
        resume_note: str | None = None,
    ) -> None:
        super().__init__(instructions=compiled.voice_instructions, tools=tools, chat_ctx=chat_ctx)
        self._compiled = compiled
        self._resume_note = resume_note

    async def on_enter(self) -> None:
        if self._resume_note is not None:
            self.session.generate_reply(instructions=self._resume_note)
        else:
            self.session.generate_reply(
                instructions=(
                    f'Greet the caller now by saying exactly: "{self._compiled.opening_line}"'
                )
            )


def conversation_of(agent: Agent) -> ChatContext:
    """What the caller heard and what tools did, without the system prompt."""
    return agent.chat_ctx.copy(
        exclude_instructions=True, exclude_handoff=True, exclude_config_update=True
    )


def resume_from(
    saved: SavedCall | None,
    recorder: CallRecorder,
    adapters: dict,
    *,
    max_age_s: float,
    now: float | None = None,
) -> tuple[ChatContext, float, int, str] | None:
    """If ``saved`` is a live call for this room, restore it and say how to resume.

    Returns (conversation, started_at, recoveries, resume note), or None for a new call.
    A saved call that ended, or that has not been touched for longer than a call may last,
    is never resumed: it belongs to an earlier call that happened to use the same room.
    """
    now = time.time() if now is None else now
    if saved is None or saved.ended or now - saved.updated_at > max_age_s:
        return None
    recorder.restore(saved.tool_calls, saved.transferred, saved.transfer_reason)
    restore_adapters(adapters, saved.adapter_state)
    return (
        ChatContext.from_dict(saved.chat),
        saved.started_at or now,
        saved.recoveries + 1,
        resume_instructions(recorder.completed_summary()),
    )


async def _safe_load(store: ConversationStore, room: str) -> SavedCall | None:
    try:
        return await store.load(room)
    except Exception:
        log.exception("could not load saved conversation for %s; starting fresh", room)
        return None


# The worker's health endpoint listens on 8081 in `start` mode, the builder API's default
# port. WORKER_PORT moves it when both run on one machine.
def sip_caller(room: rtc.Room) -> str | None:
    """The caller's number, when a phone call reached this room (LiveKit puts it on the
    phone participant's attributes); None for a browser call."""
    for p in room.remote_participants.values():
        if p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
            return p.attributes.get("sip.phoneNumber") or None
    return None


server = AgentServer(
    **({"port": int(os.environ["WORKER_PORT"])} if os.getenv("WORKER_PORT") else {})
)


@server.rtc_session(agent_name=os.getenv("AGENT_NAME", ""))
async def entrypoint(ctx: JobContext) -> None:
    room = ctx.room.name
    loaded = await resolve_config(ctx.job.metadata)
    cfg = loaded.config
    compiled = compile_agent(cfg, now=datetime.now(UTC))
    recorder = CallRecorder()
    caller: dict[str, str | None] = {"number": None}

    def note_caller(*_args) -> None:
        caller["number"] = caller["number"] or sip_caller(ctx.room)

    def caller_number() -> str | None:
        return caller["number"] or sip_caller(ctx.room)

    ctx.room.on("participant_connected", note_caller)
    ctx.room.on("participant_attributes_changed", note_caller)
    note_caller()
    tools, adapters = build_tools(cfg, compiled, recorder, lambda: caller_number())
    tools.append(EndCallTool(end_instructions=None, ignore_on_enter=True))
    store = store_from_env(CONVERSATION_DIR)

    started = time.time()
    recoveries = 0
    chat_ctx: ChatContext | None = None
    resume_note: str | None = None

    saved = await _safe_load(store, room)
    resumed = resume_from(saved, recorder, adapters, max_age_s=cfg.runtime.max_call_seconds)
    if resumed is not None:
        log.warning("resuming a call in progress for room %s", room)
        chat_ctx, started, recoveries, resume_note = resumed

    current: dict[str, AgentSession | None] = {"session": None}
    last_conversation: dict[str, ChatContext] = {"ctx": chat_ctx or ChatContext.empty()}

    def snapshot() -> SavedCall:
        session = current["session"]
        if session is not None:
            try:
                last_conversation["ctx"] = conversation_of(session.current_agent)
            except RuntimeError:
                pass  # session not running yet; keep the last conversation we had
        return SavedCall(
            room=room,
            chat=last_conversation["ctx"].to_dict(),
            tool_calls=recorder.to_json(),
            transferred=recorder.transferred,
            transfer_reason=recorder.transfer_reason,
            adapter_state=snapshot_adapters(adapters),
            started_at=started,
            updated_at=time.time(),
            recoveries=recoveries,
        )

    saver = Saver(store, snapshot)

    async def finish_call() -> None:
        try:
            await saver.flush()
            await store.end(room)
        except Exception:
            log.exception("could not mark the saved conversation ended for %s", room)
        CALL_LOG_DIR.mkdir(parents=True, exist_ok=True)
        record = {
            "room": room,
            "agent": cfg.persona.agent_name,
            "business": cfg.persona.business_name,
            "config_fingerprint": compiled.fingerprint,
            "config_source": loaded.source,
            "agent_id": loaded.agent_id,
            "agent_version": loaded.version,
            "agent_version_id": loaded.version_id,
            "voice_model": cfg.runtime.voice.model_dump(mode="json"),
            "started_at": started,
            "duration_s": round(time.time() - started, 1),
            "recoveries": recoveries,
            "caller_number": caller["number"] or sip_caller(ctx.room),
            "goal_reached": recorder.goal_reached,
            "transferred": recorder.transferred,
            "transfer_reason": recorder.transfer_reason,
            "tool_calls": recorder.to_json(),
            "transcript": last_conversation["ctx"].to_dict(),
        }
        path = CALL_LOG_DIR / f"{int(started)}-{room}.json"
        path.write_text(json.dumps(record, indent=2, default=str))
        log.info("call record written to %s", path)
        await after_call(loaded, record)

    ctx.add_shutdown_callback(finish_call)

    async def enforce_max_duration() -> None:
        await asyncio.sleep(max(0.0, cfg.runtime.max_call_seconds - (time.time() - started)))
        log.warning("max call duration reached; ending call")
        if current["session"] is not None:
            current["session"].shutdown()

    limiter = asyncio.create_task(enforce_max_duration())

    async def stop_limiter() -> None:
        limiter.cancel()

    ctx.add_shutdown_callback(stop_limiter)

    restarts = 0
    while True:
        session = AgentSession(
            llm=build_voice_model(cfg.runtime.voice, compiled),
            user_away_timeout=float(cfg.runtime.silence_timeout_seconds),
        )
        closed: asyncio.Future[CloseEvent] = asyncio.get_running_loop().create_future()

        def on_close(ev: CloseEvent, fut: asyncio.Future[CloseEvent] = closed) -> None:
            if not fut.done():
                fut.set_result(ev)

        session.on("close", on_close)
        session.on("conversation_item_added", lambda _ev: saver.mark())
        session.on("function_tools_executed", lambda _ev: saver.mark())
        current["session"] = session

        await session.start(
            agent=BuilderAgent(compiled, tools, chat_ctx=chat_ctx, resume_note=resume_note),
            room=ctx.room,
        )
        ev = await closed
        snapshot()  # capture the final conversation of this session
        current["session"] = None

        caller_here = bool(ctx.room.remote_participants)
        if ev.reason != CloseReason.ERROR or not caller_here or restarts >= MAX_RESTARTS:
            if ev.reason == CloseReason.ERROR:
                log.error("model session failed and could not be recovered: %s", ev.error)
            break

        restarts += 1
        recoveries += 1
        log.warning("model session failed (%s); resuming, attempt %d", ev.error, restarts)
        try:
            await saver.flush()
        except Exception:
            log.exception("could not save before restarting; resuming from memory")
        chat_ctx = last_conversation["ctx"]
        resume_note = resume_instructions(recorder.completed_summary())
        await asyncio.sleep(RESTART_BACKOFF_S[min(restarts, len(RESTART_BACKOFF_S)) - 1])

    ctx.shutdown(reason=ev.reason.value)


def main() -> None:
    run_preflight()
    cli.run_app(server)


if __name__ == "__main__":
    main()
