"""Where an open website chat is kept between messages.

A chat used to live only in the memory of the server that started it, so a restart, a deploy or a
second copy of the server lost it. Now its state is written to the database after every message
(rows in ``public.chat_sessions``), and any copy can pick it up and carry on.

Finishing a chat (summary, Calls, Votel) must happen exactly once, whichever copy notices that the
visitor has left, so ``claim`` and ``claim_idle`` mark a chat finished and hand its state to one
caller only.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

import aiohttp

from . import supabase

log = logging.getLogger("agent_builder.chat_store")


class ChatStore(Protocol):
    durable: bool
    """True if a chat outlives the process (so stopping one server must not end open chats)."""

    async def save(
        self, session_id: str, agent_id: str, data: dict[str, Any], last_at: float
    ) -> None: ...

    async def load(self, session_id: str) -> dict[str, Any] | None:
        """The saved state of an open chat; None if there is none or it is already finished."""

    async def claim(self, session_id: str) -> dict[str, Any] | None:
        """Mark a chat finished and return its state. None if it was already finished or unknown."""

    async def claim_idle(self, idle_s: float, limit: int = 20) -> list[tuple[str, dict[str, Any]]]:
        """Mark chats quiet for ``idle_s`` seconds as finished and return them."""

    async def reopen(self, session_id: str) -> None:
        """Put a claimed chat back to waiting (it could not be finished yet)."""


class MemoryChatStore:
    """One process only. For tests and for a machine with no database."""

    durable = False

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self.rows: dict[str, dict[str, Any]] = {}

    async def save(
        self, session_id: str, agent_id: str, data: dict[str, Any], last_at: float
    ) -> None:
        row = self.rows.setdefault(session_id, {"ended": False})
        row.update(
            agent_id=agent_id, data=json.loads(json.dumps(data, default=str)), last_at=last_at
        )

    async def load(self, session_id: str) -> dict[str, Any] | None:
        row = self.rows.get(session_id)
        return None if row is None or row["ended"] else json.loads(json.dumps(row["data"]))

    async def claim(self, session_id: str) -> dict[str, Any] | None:
        row = self.rows.get(session_id)
        if row is None or row["ended"]:
            return None
        row["ended"] = True
        return json.loads(json.dumps(row["data"]))

    async def reopen(self, session_id: str) -> None:
        if session_id in self.rows:
            self.rows[session_id]["ended"] = False

    async def claim_idle(self, idle_s: float, limit: int = 20) -> list[tuple[str, dict[str, Any]]]:
        now = self._clock()
        out = []
        for sid, row in self.rows.items():
            if not row["ended"] and now - row["last_at"] >= idle_s and len(out) < limit:
                row["ended"] = True
                out.append((sid, json.loads(json.dumps(row["data"]))))
        return out


class SupabaseChatStore:
    durable = True

    def __init__(self, url: str, key: str, *, timeout_s: float = 6.0) -> None:
        self._base = f"{url.rstrip('/')}/rest/v1"
        self._headers = supabase.headers(key)
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)

    async def save(
        self, session_id: str, agent_id: str, data: dict[str, Any], last_at: float
    ) -> None:
        # "ended" is left out on purpose: saving after a chat was finished must not reopen it.
        row = {
            "id": session_id,
            "agent_id": agent_id,
            "data": data,
            "last_at": datetime.fromtimestamp(last_at, UTC).isoformat(),
        }
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.post(
                f"{self._base}/chat_sessions",
                params={"on_conflict": "id"},
                data=json.dumps(row, default=str),
                headers={**self._headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            ) as r,
        ):
            r.raise_for_status()

    async def load(self, session_id: str) -> dict[str, Any] | None:
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.get(
                f"{self._base}/chat_sessions",
                params={"id": f"eq.{session_id}", "ended": "eq.false", "select": "data"},
                headers=self._headers,
            ) as r,
        ):
            r.raise_for_status()
            rows = await r.json()
        return rows[0]["data"] if rows else None

    async def claim(self, session_id: str) -> dict[str, Any] | None:
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.post(
                f"{self._base}/rpc/end_chat", json={"p_id": session_id}, headers=self._headers
            ) as r,
        ):
            r.raise_for_status()
            data = await r.json()
        return data if isinstance(data, dict) else None

    async def reopen(self, session_id: str) -> None:
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.patch(
                f"{self._base}/chat_sessions",
                params={"id": f"eq.{session_id}"},
                json={"ended": False},
                headers={**self._headers, "Prefer": "return=minimal"},
            ) as r,
        ):
            r.raise_for_status()

    async def claim_idle(self, idle_s: float, limit: int = 20) -> list[tuple[str, dict[str, Any]]]:
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.post(
                f"{self._base}/rpc/claim_idle_chats",
                json={"p_idle_s": max(1, int(idle_s)), "p_limit": limit},
                headers=self._headers,
            ) as r,
        ):
            r.raise_for_status()
            rows = await r.json()
        return [(str(row["id"]), row["data"]) for row in rows]


def default_store() -> ChatStore:
    creds = supabase.credentials()
    return SupabaseChatStore(*creds) if creds else MemoryChatStore()
