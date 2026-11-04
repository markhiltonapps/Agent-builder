"""A directory of voice agents inside Votel: a "Voice Agents" task board, one card per agent.

The card's column says whether the agent is live; its text says who it is for and links back
to the builder. A task board suits this better than a website collection: it lives in Votel's
Tasks, is private, and a column per state is easy to scan. The agent's id is written into the
card so the right card is found again on every sync.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .votel import UUID, VotelConfig, call_tool, first_id

PROJECT = "Voice Agents"
TEMPLATE = "Voice agent status"
NOT_LIVE, LIVE, RETIRED = "NOT LIVE", "LIVE", "RETIRED"
STATUSES = [
    {"name": NOT_LIVE, "color": "#94A3B8", "category": "not_started"},
    {"name": LIVE, "color": "#22C55E", "category": "active"},
    {"name": RETIRED, "color": "#64748B", "category": "closed"},
]


@dataclass(frozen=True)
class AgentCard:
    agent_id: str
    name: str
    workspace: str
    business: str
    about: str
    live_version: int | None
    app_url: str
    retired: bool = False

    @property
    def status(self) -> str:
        return RETIRED if self.retired else LIVE if self.live_version else NOT_LIVE

    def description(self) -> str:
        base = self.app_url.rstrip("/")
        lines = [
            f"{self.business}" + (f": {self.about.strip()[:240]}" if self.about.strip() else "")
        ]
        lines += [
            "",
            f"Live version: {self.live_version}" if self.live_version else "Not published yet.",
            f"Workspace: {self.workspace}",
            "",
            f"Open in the builder: {base}/agents/{self.agent_id}",
            f"Past calls: {base}/calls?agent={self.agent_id}",
            "",
            f"Agent ID: {self.agent_id}",
        ]
        return "\n".join(lines)


def id_on_line_with(name: str, text: str) -> str | None:
    """The first UUID on the first line that mentions ``name`` (Votel lists things as text)."""
    for line in text.splitlines():
        if name.lower() in line.lower():
            m = UUID.search(line)
            if m:
                return m.group(0)
    return None


async def ensure_board(cfg: VotelConfig) -> None:
    """Create the "Voice Agents" board (and its status template) if it is not there yet."""
    if PROJECT.lower() in (await call_tool(cfg, "list_projects", {})).lower():
        return
    template_id = id_on_line_with(TEMPLATE, await call_tool(cfg, "list_status_templates", {}))
    if not template_id:
        template_id = first_id(
            await call_tool(cfg, "create_status_template", {"name": TEMPLATE, "statuses": STATUSES})
        )
    if not template_id:
        raise_missing("the status template")
    await call_tool(
        cfg,
        "create_project",
        {
            "name": PROJECT,
            "status_template_id": template_id,
            "description": "One card per voice agent built in the Neato Agent Builder. Managed automatically.",
            "color": "#22C55E",
        },
    )


def raise_missing(what: str) -> None:
    from .votel import VotelError

    raise VotelError(f"Votel did not return an id for {what}")


async def sync_agent(cfg: VotelConfig, card: AgentCard) -> str:
    """Create or update this agent's card. Returns "created" or "updated"."""
    await ensure_board(cfg)
    # Votel does the search (the agent's id is in the card text), so any row it returns is this
    # agent's card. Only list rows count: a heading must never be mistaken for a task.
    found = await call_tool(
        cfg, "list_tasks", {"project": PROJECT, "search": card.agent_id, "limit": 5}
    )
    rows = [ln for ln in found.splitlines() if ln.lstrip().startswith("-") and UUID.search(ln)]
    existing = first_id(rows[0]) if rows else None
    fields = {"title": card.name[:200], "description": card.description(), "status": card.status}
    if existing:
        await call_tool(cfg, "update_task", {"task_id": existing, **fields})
        return "updated"
    await call_tool(cfg, "create_task", {**fields, "project": PROJECT, "tags": ["voice-agent"]})
    return "created"


_SAFE = re.compile(r"\s+")


def tidy(text: str) -> str:
    return _SAFE.sub(" ", text).strip()
