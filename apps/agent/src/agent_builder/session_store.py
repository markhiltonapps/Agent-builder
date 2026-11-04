"""Per-room conversation memory that outlives a model session.

The worker, not the model provider, owns the conversation. Every turn is saved here, keyed
by room name, so anything that starts a fresh session for a call still in progress (an
in-job restart after a model error, a provider switch, a worker restart that re-dispatches
the room) reloads the conversation instead of greeting the caller again.

Stores:
  MemoryStore    tests
  FileStore      local dev (``CONVERSATION_DIR``); one process only
  SupabaseStore  production; table ``live_calls`` via PostgREST
                 (``SUPABASE_URL`` + ``SUPABASE_SECRET_KEY``)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

import aiohttp

log = logging.getLogger("agent_builder.session_store")


@dataclass
class SavedCall:
    room: str
    chat: dict[str, Any]
    """``ChatContext.to_dict()`` of everything said and every tool call so far."""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    transferred: bool = False
    transfer_reason: str | None = None
    adapter_state: dict[str, Any] = field(default_factory=dict)
    started_at: float = 0.0
    updated_at: float = 0.0
    recoveries: int = 0
    ended: bool = False

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> SavedCall:
        known = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
        return cls(**known)


class ConversationStore(Protocol):
    async def load(self, room: str) -> SavedCall | None: ...
    async def save(self, call: SavedCall) -> None: ...
    async def end(self, room: str) -> None: ...


class MemoryStore:
    def __init__(self) -> None:
        self.calls: dict[str, dict[str, Any]] = {}

    async def load(self, room: str) -> SavedCall | None:
        data = self.calls.get(room)
        return SavedCall.from_json(json.loads(json.dumps(data))) if data else None

    async def save(self, call: SavedCall) -> None:
        self.calls[call.room] = json.loads(json.dumps(call.to_json(), default=str))

    async def end(self, room: str) -> None:
        if room in self.calls:
            self.calls[room]["ended"] = True


_SAFE = re.compile(r"[^A-Za-z0-9_.-]")


class FileStore:
    """One JSON file per room. Writes go to a temp file and are renamed into place."""

    def __init__(self, directory: Path) -> None:
        self.dir = directory

    def _path(self, room: str) -> Path:
        return self.dir / f"{_SAFE.sub('_', room)}.json"

    async def load(self, room: str) -> SavedCall | None:
        p = self._path(room)
        if not p.exists():
            return None
        try:
            return SavedCall.from_json(json.loads(p.read_text()))
        except (OSError, ValueError, TypeError):
            log.exception("unreadable saved call for room %s", room)
            return None

    async def save(self, call: SavedCall) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        p = self._path(call.room)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(call.to_json(), default=str))
        tmp.replace(p)

    async def end(self, room: str) -> None:
        saved = await self.load(room)
        if saved:
            saved.ended = True
            await self.save(saved)


class SupabaseStore:
    """Rows in ``public.live_calls`` (room text primary key, data jsonb, ended bool).

    Uses the project's secret key, so the table needs RLS on and no public policies.
    """

    def __init__(self, url: str, key: str, *, table: str = "live_calls") -> None:
        self._base = f"{url.rstrip('/')}/rest/v1/{table}"
        self._headers = {"apikey": key, "Content-Type": "application/json"}
        if not key.startswith("sb_"):  # a legacy service_role JWT also goes as a bearer token
            self._headers["Authorization"] = f"Bearer {key}"
        self._http: aiohttp.ClientSession | None = None

    def _session(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5))
        return self._http

    async def load(self, room: str) -> SavedCall | None:
        async with self._session().get(
            self._base,
            params={"room": f"eq.{room}", "select": "data,ended"},
            headers=self._headers,
        ) as r:
            r.raise_for_status()
            rows = await r.json()
        if not rows:
            return None
        saved = SavedCall.from_json(rows[0]["data"])
        saved.ended = bool(rows[0]["ended"])
        return saved

    async def save(self, call: SavedCall) -> None:
        body = {"room": call.room, "data": call.to_json(), "ended": call.ended}
        headers = {**self._headers, "Prefer": "resolution=merge-duplicates,return=minimal"}
        async with self._session().post(
            self._base, data=json.dumps(body, default=str), headers=headers
        ) as r:
            r.raise_for_status()

    async def end(self, room: str) -> None:
        headers = {**self._headers, "Prefer": "return=minimal"}
        async with self._session().patch(
            self._base, params={"room": f"eq.{room}"}, json={"ended": True}, headers=headers
        ) as r:
            r.raise_for_status()

    async def aclose(self) -> None:
        if self._http and not self._http.closed:
            await self._http.close()


def store_from_env(default_dir: Path) -> ConversationStore:
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SECRET_KEY")
    if url and key:
        return SupabaseStore(url, key)
    return FileStore(Path(os.getenv("CONVERSATION_DIR", default_dir)))


class Saver:
    """Coalesces saves: at most one write in flight, and the latest state always lands.

    A failed write is logged and retried on the next change; it never touches the call.
    """

    def __init__(self, store: ConversationStore, snapshot: Any) -> None:
        self._store = store
        self._snapshot = snapshot  # () -> SavedCall
        self._dirty = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def mark(self) -> None:
        self._dirty.set()
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="conversation-saver")

    async def _run(self) -> None:
        while self._dirty.is_set():
            self._dirty.clear()
            try:
                await self._store.save(self._snapshot())
            except Exception:
                log.exception("saving the conversation failed; will retry on the next turn")
                return

    async def flush(self) -> None:
        if self._task and not self._task.done():
            await self._task
        if self._dirty.is_set():
            self._dirty.clear()
            await self._store.save(self._snapshot())
