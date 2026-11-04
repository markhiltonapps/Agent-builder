"""LiveKit worker: one shared fleet, config loaded per call.

Run locally:  uv run agent-builder dev      (then talk to it in the LiveKit Agents Playground)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli
from livekit.agents.beta.tools import EndCallTool

from .compiler import CompiledAgent, compile_agent
from .loader import ROOT, load_config
from .providers import build_voice_model
from .tools import CallRecorder, build_tools

load_dotenv(ROOT / ".env")
log = logging.getLogger("agent_builder")

CALL_LOG_DIR = Path(os.getenv("CALL_LOG_DIR", ROOT / "call_logs"))


class BuilderAgent(Agent):
    def __init__(self, compiled: CompiledAgent, tools: list) -> None:
        super().__init__(instructions=compiled.voice_instructions, tools=tools)
        self._compiled = compiled

    async def on_enter(self) -> None:
        self.session.generate_reply(
            instructions=f'Greet the caller now by saying exactly: "{self._compiled.opening_line}"'
        )


server = AgentServer()


@server.rtc_session(agent_name=os.getenv("AGENT_NAME", ""))
async def entrypoint(ctx: JobContext) -> None:
    cfg = load_config(ctx.job.metadata)
    compiled = compile_agent(cfg, now=datetime.now(UTC))
    recorder = CallRecorder()
    tools, _ = build_tools(cfg, compiled, recorder)
    tools.append(EndCallTool(end_instructions=None, ignore_on_enter=True))

    session = AgentSession(
        llm=build_voice_model(cfg.runtime.voice, compiled),
        user_away_timeout=float(cfg.runtime.silence_timeout_seconds),
    )
    started = time.time()

    async def write_call_record() -> None:
        CALL_LOG_DIR.mkdir(parents=True, exist_ok=True)
        record = {
            "room": ctx.room.name,
            "agent": cfg.persona.agent_name,
            "business": cfg.persona.business_name,
            "config_fingerprint": compiled.fingerprint,
            "voice_model": cfg.runtime.voice.model_dump(mode="json"),
            "started_at": started,
            "duration_s": round(time.time() - started, 1),
            "goal_reached": recorder.goal_reached,
            "transferred": recorder.transferred,
            "transfer_reason": recorder.transfer_reason,
            "tool_calls": [asdict(c) for c in recorder.calls],
            "transcript": session.history.to_dict(),
        }
        path = CALL_LOG_DIR / f"{int(started)}-{ctx.room.name}.json"
        path.write_text(json.dumps(record, indent=2, default=str))
        log.info("call record written to %s", path)

    ctx.add_shutdown_callback(write_call_record)

    async def enforce_max_duration() -> None:
        await asyncio.sleep(cfg.runtime.max_call_seconds)
        log.warning("max call duration reached; ending call")
        session.shutdown()

    limiter = asyncio.create_task(enforce_max_duration())

    async def stop_limiter() -> None:
        limiter.cancel()

    ctx.add_shutdown_callback(stop_limiter)

    await session.start(agent=BuilderAgent(compiled, tools), room=ctx.room)


def main() -> None:
    cli.run_app(server)


if __name__ == "__main__":
    main()
