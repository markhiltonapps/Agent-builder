"""Deterministic compiler: AgentConfig -> what the models actually receive.

Same config in, same prompts out, byte for byte. The editor shows this output read-only so
anyone can see exactly what the model is told. The voice model and the backend model get
separate instructions because GPT-Live delegates tool work to a backend model.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from .config import AgentConfig, ToolDefinition

_TONE = {
    "warm": "Sound warm and friendly, like a helpful person at the front desk.",
    "professional": "Sound polished and professional. Be courteous and efficient.",
    "upbeat": "Sound upbeat and energetic without being pushy.",
    "calm": "Sound calm and reassuring. Speak at an unhurried pace.",
}

_INTERRUPTION = {
    "yield_immediately": "If the caller starts talking, stop and listen right away.",
    "finish_sentence": "If the caller starts talking, finish your current short sentence, "
    "then stop and listen.",
}

_BACKCHANNEL = {
    "none": "Do not use filler acknowledgements while the caller is speaking.",
    "light": "Use an occasional short acknowledgement like 'mm-hm' or 'got it' when the "
    "caller pauses mid-thought.",
    "natural": "Use natural acknowledgements like 'mm-hm', 'okay' and 'sure' as a person would.",
}

_BASE_SPEAKING_RULES = """\
- This is a phone call. Keep every reply to one or two short sentences.
- Ask one question at a time and wait for the answer.
- Never read out lists longer than three items; offer the top options and ask.
- Say numbers, dates and times the way a person would say them aloud.
- Read back phone numbers, addresses and appointment times to confirm them.
- Never invent prices, availability or policies. Use your tools to look them up."""


@dataclass(frozen=True)
class CompiledAgent:
    voice_instructions: str
    backend_instructions: str
    opening_line: str
    goodbye_line: str
    still_there_line: str
    tools: tuple[ToolDefinition, ...]
    fingerprint: str
    """sha256 of the compiled output; changes iff what the model receives changes."""


def _fill(text: str, cfg: AgentConfig) -> str:
    return text.replace("{business}", cfg.persona.business_name).replace(
        "{agent_name}", cfg.persona.agent_name
    )


def _section(title: str, body: str) -> str:
    body = body.strip()
    return f"# {title}\n{body}" if body else ""


def _join(*sections: str) -> str:
    return "\n\n".join(s for s in sections if s)


def compile_agent(cfg: AgentConfig, now: datetime | None = None) -> CompiledAgent:
    """Compile ``cfg``. Pass ``now`` at call time to tell the models today's date; the date
    is left out of the fingerprint, which tracks the config alone."""
    p = cfg.persona
    tools = tuple(cfg.enabled_tools())

    identity = f"You are {p.agent_name}, the phone assistant for {p.business_name}." + (
        f" {p.business_description.strip()}" if p.business_description.strip() else ""
    )
    if p.bot_disclosure.strip():
        identity += (
            f"\nIf asked whether you are a person or AI, say: {_fill(p.bot_disclosure, cfg)}"
        )
    if p.languages != ["en"]:
        identity += (
            "\nYou can speak these languages: "
            + ", ".join(p.languages)
            + ". Reply in the caller's language."
        )

    style = "\n".join(
        [
            f"- {_TONE[p.tone]}",
            f"- {_INTERRUPTION[cfg.policy.interruption]}",
            f"- {_BACKCHANNEL[cfg.policy.backchannel]}",
        ]
    )
    speaking = _BASE_SPEAKING_RULES
    if cfg.policy.speaking_rules.strip():
        speaking += "\n" + cfg.policy.speaking_rules.strip()

    calls = "\n".join(
        [
            f'- Open the call with: "{_fill(cfg.greetings.opening, cfg)}"',
            f'- If the caller goes quiet, say: "{_fill(cfg.greetings.still_there, cfg)}"',
            (
                f'- When the caller is done, say: "{_fill(cfg.greetings.goodbye, cfg)}" '
                "and then end the call."
            ),
        ]
    )

    guardrails = "\n".join(f"- {g.strip()}" for g in cfg.guardrails)

    escalation_lines = []
    for rule in cfg.escalation:
        verb = {
            "transfer": "transfer the call to a person",
            "take_message": "take a message with the caller's name, number and reason",
            "end_call": "politely end the call",
        }[rule.action]
        escalation_lines.append(f"- If {rule.condition.strip().rstrip('.')}: {verb}.")
    escalation = "\n".join(escalation_lines)

    capabilities = "\n".join(f"- {t.description.strip()}" for t in tools)
    if capabilities:
        capabilities = (
            "You can do the following for callers. When a request needs one of these, "
            "hand it off and tell the caller briefly what you are doing.\n" + capabilities
        )

    voice = _join(
        _section("Identity", identity),
        _section("Style", style),
        _section("Speaking rules", speaking),
        _section("Call flow", calls),
        _section("What you can do", capabilities),
        _section("Guardrails", guardrails),
        _section("Escalation", escalation),
    )

    backend = _join(
        _section(
            "Role",
            f"You run tools for {p.agent_name}, the phone assistant for {p.business_name}. "
            "Your reply is spoken aloud to a caller, so answer in one or two plain sentences "
            "with no lists, markdown or URLs.",
        ),
        _section("Backend flows", cfg.policy.backend_flows),
        _section("Guardrails", guardrails),
        _section(
            "Tool use",
            "- Only state facts that a tool returned.\n"
            "- If a tool fails, say you could not complete it and offer to take a message.\n"
            "- Do not call the same tool twice with the same arguments.",
        ),
    )

    payload = json.dumps(
        {
            "voice": voice,
            "backend": backend,
            "tools": [t.model_dump(mode="json") for t in tools],
            "runtime": cfg.runtime.model_dump(mode="json"),
        },
        sort_keys=True,
    )
    fingerprint = hashlib.sha256(payload.encode()).hexdigest()

    if now is not None:
        local = now.astimezone(ZoneInfo(p.timezone))
        today = _section(
            "Today",
            f"It is {local:%A, %B} {local.day}, {local.year} ({local:%Y-%m-%d}), "
            f"{local:%-I:%M %p} local time. Work out dates like 'tomorrow' from this.",
        )
        voice, backend = _join(voice, today), _join(backend, today)

    return CompiledAgent(
        voice_instructions=voice,
        backend_instructions=backend,
        opening_line=_fill(cfg.greetings.opening, cfg),
        goodbye_line=_fill(cfg.greetings.goodbye, cfg),
        still_there_line=_fill(cfg.greetings.still_there, cfg),
        tools=tools,
        fingerprint=fingerprint,
    )
