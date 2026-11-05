"""Bring an agent built in Votel into the builder.

Votel's AI agents are free-text prompts; the builder's agents are structured. So the import reads
the Votel agent (its prompt, greetings, voice, languages) and hands it to the same AI drafter that
writes agents from a description, then the person reviews the draft. Nothing here changes Votel.

Not carried over: Votel's workflows, tools, knowledge base and phone numbers.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

from .votel import UUID, VotelConfig, VotelError, call_tool

# "- Brightwater Family Dental [live] channels: chat, sms | agent_id: <uuid> | numbers: 0, ..."
_LINE = re.compile(
    r"^-\s+(?P<name>.+?)\s+\[(?P<status>[a-z_]+)\]\s+channels:\s*(?P<channels>.*?)\s*\|\s*agent_id:\s*"
    rf"(?P<id>{UUID.pattern})",
    re.IGNORECASE,
)

MAX_DIGEST = 12_000


@dataclass(frozen=True)
class VotelAgent:
    id: str
    name: str
    status: str
    channels: str

    def to_json(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "status": self.status, "channels": self.channels}


def parse_agents(text: str) -> list[VotelAgent]:
    """Votel lists agents as text, one per line; names arrive HTML-escaped."""
    agents = []
    for line in text.splitlines():
        m = _LINE.match(line.strip())
        if m:
            agents.append(
                VotelAgent(
                    id=m["id"].lower(),
                    name=html.unescape(m["name"]).strip(),
                    status=m["status"].lower(),
                    channels=m["channels"].strip(),
                )
            )
    return agents


async def list_agents(cfg: VotelConfig) -> list[VotelAgent]:
    return parse_agents(await call_tool(cfg, "list_ai_agents", {}))


async def fetch_agent(cfg: VotelConfig, agent_id: str) -> str:
    """Everything Votel will tell us about the agent, as one block of text."""
    if not UUID.fullmatch(agent_id):
        raise VotelError("That is not a Votel agent id.")
    text = await call_tool(cfg, "get_ai_agent", {"agent_id": agent_id, "full_prompt": True})
    return html.unescape(text)


def as_brief(name: str, digest: str) -> str:
    """The request given to the drafter: convert this agent, keep what it says, invent nothing."""
    body = digest.strip()
    if len(body) > MAX_DIGEST:
        body = body[:MAX_DIGEST] + "\n[the rest was cut for length]"
    return (
        f'Rewrite an existing voice agent called "{name}" from another platform as a new agent '
        "configuration. Keep its persona name, tone, business facts, FAQs, rules, greetings and "
        "the way it handles each kind of call, as faithfully as you can, in the structure you "
        "were given. Do not add facts, prices, hours or policies that are not in it. Where the "
        "original relies on tools, bookings or workflows that this agent does not have, have the "
        "agent take a message instead.\n\n"
        f"--- the existing agent, exactly as it is set up ---\n{body}\n--- end ---"
    )


# "- Free Plumbing Estimate [LIVE] [appointment] 60min id: <uuid>"
_BOOKABLE = re.compile(
    r"^-\s+(?P<name>.+?)\s+\[(?P<status>[A-Za-z_]+)\]\s+\[(?P<kind>[a-z]+)\]\s+(?P<minutes>\d+)\s*min\s+id:\s*"
    rf"(?P<id>{UUID.pattern})",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Bookable:
    id: str
    name: str
    status: str
    kind: str
    minutes: int

    def to_json(self) -> dict[str, str | int]:
        return {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "kind": self.kind,
            "minutes": self.minutes,
        }


def parse_bookables(text: str) -> list[Bookable]:
    """Votel's booking services (what a customer can book), one per line of text."""
    found = []
    for line in text.splitlines():
        m = _BOOKABLE.match(line.strip())
        if m:
            found.append(
                Bookable(
                    id=m["id"].lower(),
                    name=html.unescape(m["name"]).strip(),
                    status=m["status"].lower(),
                    kind=m["kind"].lower(),
                    minutes=int(m["minutes"]),
                )
            )
    return found


async def list_bookables(cfg: VotelConfig) -> list[Bookable]:
    return parse_bookables(await call_tool(cfg, "list_bookables", {}))
