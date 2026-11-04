"""Turn data-defined tools into LiveKit function tools bound to adapters."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from livekit.agents import RunContext, ToolError, function_tool
from livekit.agents.llm import RawFunctionTool

from .adapters import Adapter, ToolFailed, build_adapter
from .compiler import CompiledAgent
from .config import AgentConfig, ToolDefinition

log = logging.getLogger("agent_builder.tools")

SLOW_TOOL_SECONDS = 2.0
"""A tool slower than this stalls the caller audibly; the call log flags it."""


@dataclass
class ToolCallRecord:
    tool: str
    args: dict[str, Any]
    ok: bool
    result: Any
    latency_ms: int
    goal: bool


@dataclass
class CallRecorder:
    """Everything the call record needs from tool use: what ran, how fast, goal reached."""

    calls: list[ToolCallRecord] = field(default_factory=list)
    transferred: bool = False
    transfer_reason: str | None = None

    @property
    def goal_reached(self) -> bool:
        return any(c.goal and c.ok for c in self.calls)


def _make_tool(defn: ToolDefinition, adapter: Adapter, recorder: CallRecorder) -> RawFunctionTool:
    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
        args = dict(raw_arguments)
        started = time.perf_counter()
        try:
            result = await adapter.call(defn.name, args)
            ok = True
        except ToolFailed as e:
            result, ok = {"error": str(e)}, False
        except Exception:  # an adapter bug must not kill the call
            log.exception("tool %s crashed", defn.name)
            result, ok = {"error": "internal error"}, False
        latency_ms = int((time.perf_counter() - started) * 1000)
        if latency_ms > SLOW_TOOL_SECONDS * 1000:
            log.warning("tool %s took %d ms", defn.name, latency_ms)
        recorder.calls.append(ToolCallRecord(defn.name, args, ok, result, latency_ms, defn.goal))
        if not ok:
            raise ToolError(f"{defn.name} failed: {result['error']}")
        return json.dumps(result)

    return function_tool(
        handler,
        raw_schema={
            "name": defn.name,
            "description": defn.description,
            "parameters": defn.json_schema(),
        },
    )


def _transfer_tool(cfg: AgentConfig, recorder: CallRecorder) -> RawFunctionTool:
    rules = "; ".join(r.condition for r in cfg.escalation if r.action == "transfer")
    description = "Transfer the caller to a human team member."
    if rules:
        description += f" Use when: {rules}."

    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
        recorder.transferred = True
        recorder.transfer_reason = str(raw_arguments.get("reason", ""))
        # Step 3 wires this to a SIP transfer. Until then the call log records the intent.
        log.info("transfer requested: %s", recorder.transfer_reason)
        return json.dumps(
            {"status": "transfer_requested", "say": "Let me connect you with someone now."}
        )

    return function_tool(
        handler,
        raw_schema={
            "name": "transfer_to_human",
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "One sentence on why the caller needs a person.",
                    }
                },
                "required": ["reason"],
                "additionalProperties": False,
            },
        },
    )


def build_tools(
    cfg: AgentConfig, compiled: CompiledAgent, recorder: CallRecorder
) -> tuple[list[Any], dict[str, Adapter]]:
    """Return the LiveKit tools for one call and the adapters backing them.

    Adapters are built per call so mock state never leaks between calls.
    """
    adapters = {
        name: build_adapter(name, a)
        for name, a in cfg.adapters.items()
        if a.kind != "disabled" and any(t.adapter == name for t in compiled.tools)
    }
    tools: list[Any] = [_make_tool(t, adapters[t.adapter], recorder) for t in compiled.tools]
    tools.append(_transfer_tool(cfg, recorder))
    return tools, adapters
