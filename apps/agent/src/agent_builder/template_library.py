"""Ready-made agents: one editable starting point per kind of business.

Each industry is a short ``Industry`` spec (who the agent is, what it asks, when it hands off, the
rules that matter in that trade). ``build()`` turns a spec into a full, validated ``AgentConfig``
by adding the parts every receptionist shares (taking a message, being honest about what it can
do, handing off emergencies). The result is written to ``templates/library.json`` for the web
app's picker; ``uv run python -m agent_builder.template_library`` regenerates it.

What a template never does: invent prices, hours, addresses, staff names or policies. It knows
only what the owner types in, and takes a message for everything else. It also never says an
appointment is confirmed, and never says it is connecting a call it cannot connect.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from .config import AgentConfig

Tone = Literal["warm", "professional", "upbeat", "calm"]

LIBRARY_FILE = Path(__file__).resolve().parents[2] / "templates" / "library.json"


@dataclass(frozen=True)
class Industry:
    key: str
    """Short lowercase id, letters and dashes only: ``auto-repair``."""
    label: str
    """What the picker shows: ``Auto repair``."""
    icon: str
    """One emoji for the picker card."""
    blurb: str
    """One plain sentence for the card: what this agent does for the business."""
    agent_name: str
    """The first name the agent uses on calls."""
    tone: Tone
    description: str
    """The business, in general terms. The owner replaces it with their own details."""
    opening: str
    """First thing said. May use ``{business}`` and ``{agent_name}``."""
    disclosure: str
    """What it says when asked if it is a person. May use ``{business}``."""
    handles: list[str]
    """Three to five plain phrases for the card: the calls this agent takes."""
    collects: list[str] = field(default_factory=list)
    """Extra things to ask, in order, beyond name, phone, email and reason. Plain questions."""
    guardrails: list[str] = field(default_factory=list)
    """Rules specific to this trade. Imperative sentences starting with Never or Always."""
    urgent: str | None = None
    """When to hand off right away, as a condition: ``the caller describes a medical emergency``."""
    urgent_rule: str = ""
    """What to say before anything else in that situation. One sentence."""
    transfer_when: list[str] = field(default_factory=list)
    """Other conditions that call for a live person (VIP, complaint, a named person)."""
    message_when: list[tuple[str, str]] = field(default_factory=list)
    """(condition, summary) pairs: things the agent cannot answer, so it takes a message."""
    speaking_rules: str = ""
    """Extra speaking rules, as ``- `` bullets."""
    flows: str = ""
    """Trade-specific step-by-step flows appended after the shared message flow."""


# --- the parts every receptionist shares --------------------------------------------------

COMMON_GUARDRAILS = [
    "Never make up prices, hours, addresses, availability, policies or names. If you are not told, say you are not sure and offer to take a message.",
    "Never say an appointment or booking is confirmed. Say the team will confirm it.",
    "Never take card numbers, bank details, passwords or government ID numbers on the call.",
    "Stay on this business's topics. Politely decline unrelated requests and offer to take a message instead.",
]

COMMON_SPEAKING = (
    "- Ask for one thing at a time and wait for the answer.\n"
    "- When you are not sure you heard a name or email right, ask the caller to spell it, then say it back.\n"
    "- Read a phone number back digit by digit before you save it."
)

MESSAGE_FLOW = """Take a message or a request:
1. Find out what the caller needs and why they are calling.
2. Ask for their first name, then their last name.
3. Confirm the best number to reach them. If you already have the number from the call, confirm it.
4. Ask for an email address so the team can send details. If they would rather not, move on.
{extras}{n_appt}. If they want an appointment, ask for the day and time they prefer and one backup. If you can send a booking link, offer it. Never say the appointment is confirmed; say the team will confirm it.
{n_save}. Call take_message with everything you gathered. Set request_type to appointment, quote, callback, urgent or message, whichever fits. Then tell the caller in one sentence what happens next."""


def _flows(i: Industry) -> str:
    extras = "".join(f"{n}. {q}\n" for n, q in enumerate(i.collects, start=5))
    n = 5 + len(i.collects)
    shared = MESSAGE_FLOW.format(extras=extras, n_appt=n, n_save=n + 1)
    return shared + (f"\n\n{i.flows.strip()}" if i.flows.strip() else "")


def build(i: Industry) -> dict[str, Any]:
    """A full agent config for this industry, validated before it is returned."""
    escalation: list[dict[str, str]] = []
    if i.urgent:
        escalation.append(
            {
                "condition": i.urgent,
                "action": "transfer",
                "handoff_summary": "Urgent: {reason}",
            }
        )
    escalation += [
        {"condition": c, "action": "transfer", "handoff_summary": "Needs a person: {reason}"}
        for c in i.transfer_when
    ]
    escalation.append(
        {
            "condition": "the caller asks for a person, or is upset after two attempts to help",
            "action": "transfer",
            "handoff_summary": "Caller asked for a person: {reason}",
        }
    )
    escalation += [
        {"condition": c, "action": "take_message", "handoff_summary": s} for c, s in i.message_when
    ]
    speaking = COMMON_SPEAKING
    if i.urgent_rule:
        speaking = f"- {i.urgent_rule}\n" + speaking
    if i.speaking_rules.strip():
        speaking += "\n" + i.speaking_rules.strip()
    config: dict[str, Any] = {
        "schema_version": 1,
        "persona": {
            "agent_name": i.agent_name,
            "business_name": "Your business",
            "business_description": i.description,
            "tone": i.tone,
            "languages": ["en"],
            "timezone": "America/Chicago",
            "bot_disclosure": i.disclosure,
        },
        "greetings": {
            "opening": i.opening,
            "still_there": "Are you still there?",
            "goodbye": "Thanks for calling {business}. Have a great day!",
        },
        "guardrails": [*i.guardrails, *COMMON_GUARDRAILS],
        "escalation": escalation,
        "policy": {
            "speaking_rules": speaking,
            "backend_flows": _flows(i),
            "interruption": "yield_immediately",
            "backchannel": "light",
        },
        "tools": [],
        "adapters": {},
    }
    return AgentConfig.model_validate(config).model_dump(mode="json", exclude_none=True)


_ASK = re.compile(r"^ask (for |if |whether )?(the |a |an )?(.*)$", re.IGNORECASE)
_CONDITIONAL = re.compile(
    r"^(if [^,]+), ask (for |if |whether )?(the |a |an )?(.*)$", re.IGNORECASE
)


def plain_ask(instruction: str) -> str:
    """An instruction to the agent, as the owner would read it.

    "Ask for the car's year" -> "Car's year";  "Ask if they own the home" -> "Whether they own the
    home";  "If they are buying, ask if they are pre-approved" -> "Whether they are pre-approved
    (if they are buying)". Only the first sentence is kept.
    """
    first = re.split(r"(?<=[.?])\s", instruction.strip(), maxsplit=1)[0].rstrip(".?")
    when = ""
    if m := _CONDITIONAL.match(first):
        when, lead, rest = f" ({m.group(1)[:1].lower()}{m.group(1)[1:]})", m.group(2), m.group(4)
    elif m := _ASK.match(first):
        lead, rest = m.group(1), m.group(3)
    else:
        return first[:1].upper() + first[1:]
    if (lead or "").strip().lower() in ("if", "whether"):
        rest = f"whether {rest}"
    return (rest[:1].upper() + rest[1:]) + when


def entry(i: Industry) -> dict[str, Any]:
    """One picker entry: the card's text plus the full config."""
    config = build(i)
    return {
        "key": i.key,
        "label": i.label,
        "icon": i.icon,
        "blurb": i.blurb,
        "handles": i.handles,
        "asks": [
            "First and last name",
            "Phone number",
            "Email",
            "Why they are calling",
            *(plain_ask(q) for q in i.collects),
        ],
        "handsOff": bool(i.urgent or i.transfer_when),
        "greeting": i.opening,
        "description": i.description,
        "agentName": i.agent_name,
        "config": config,
    }


def all_industries() -> list[Industry]:
    from .template_specs import SPECS

    return sorted(SPECS, key=lambda s: (s.key == "general", s.label.lower()))


def library() -> list[dict[str, Any]]:
    return [entry(i) for i in all_industries()]


def write(path: Path = LIBRARY_FILE) -> int:
    data = library()
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return len(data)


if __name__ == "__main__":
    print(f"wrote {write()} templates to {LIBRARY_FILE}", file=sys.stderr)
