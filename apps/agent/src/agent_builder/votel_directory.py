"""A directory of voice agents inside Votel: an "Agent Builder OS" task board, one card per agent.

The card's column says whether the agent is live; its text says who it is for and links back
to the builder. A task board suits this better than a website collection: it lives in Votel's
Tasks, is private, and a column per state is easy to scan. The agent's id is written into the
card so the right card is found again on every sync.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .votel import UUID, VotelConfig, VotelError, call_tool, first_id

PROJECT = "Agent Builder OS"
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
    """Create the "Agent Builder OS" board (and its status template) if it is not there yet."""
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
    raise VotelError(f"Votel did not return an id for {what}")


@dataclass(frozen=True)
class Synced:
    result: str  # "created" or "updated"
    task_id: str


async def _find_card(cfg: VotelConfig, card: AgentCard) -> str | None:
    """Find an existing card without a remembered id. Votel's search only reads titles, so
    search by the agent's name and confirm each hit by the agent id written in its text."""
    found = await call_tool(
        cfg, "list_tasks", {"project": PROJECT, "search": card.name, "limit": 25}
    )
    for line in found.splitlines():
        if line.lstrip().startswith("-") and UUID.search(line):
            candidate = first_id(line)
            if candidate and card.agent_id in await call_tool(
                cfg, "get_task", {"task_id": candidate}
            ):
                return candidate
    return None


async def sync_agent(cfg: VotelConfig, card: AgentCard, task_id: str | None = None) -> Synced:
    """Create or update this agent's card. ``task_id`` is the card id remembered from last time.

    A remembered id that no longer works (someone deleted the card) falls back to finding or
    creating the card, so the directory heals itself.
    """
    await ensure_board(cfg)
    fields = {"title": card.name[:200], "description": card.description(), "status": card.status}
    if task_id:
        try:
            await call_tool(cfg, "update_task", {"task_id": task_id, **fields})
            return Synced("updated", task_id)
        except VotelError:
            task_id = None
    task_id = await _find_card(cfg, card)
    if task_id:
        await call_tool(cfg, "update_task", {"task_id": task_id, **fields})
        return Synced("updated", task_id)
    made = first_id(
        await call_tool(cfg, "create_task", {**fields, "project": PROJECT, "tags": ["voice-agent"]})
    )
    if not made:
        raise_missing("the new card")
    return Synced("created", made)


_SAFE = re.compile(r"\s+")


def tidy(text: str) -> str:
    return _SAFE.sub(" ", text).strip()
