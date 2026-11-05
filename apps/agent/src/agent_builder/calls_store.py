"""Save finished calls to the database so the builder can show them.

The worker keeps writing its JSON file too: a database outage must never lose a call. Only
calls for a database agent (``LoadedConfig.agent_id``) are saved; a template run from a file
belongs to no account.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

import aiohttp

from . import supabase
from .loader import LoadedConfig

log = logging.getLogger("agent_builder.calls_store")

MAX_TRANSCRIPT_LINES = 2000
MAX_TEXT = 4000


def transcript_lines(chat: dict[str, Any]) -> list[dict[str, str]]:
    """What was said, in order: ``[{"who": "caller"|"agent", "text": ...}]``.

    ``chat`` is ``ChatContext.to_dict()``. Tool traffic is recorded separately, and system
    items are left out.
    """
    lines: list[dict[str, str]] = []
    for item in chat.get("items", []):
        if item.get("type") != "message" or item.get("role") not in ("user", "assistant"):
            continue
        text = " ".join(c for c in item.get("content", []) if isinstance(c, str)).strip()
        if text:
            who = "caller" if item["role"] == "user" else "agent"
            lines.append({"who": who, "text": text[:MAX_TEXT]})
    return lines[:MAX_TRANSCRIPT_LINES]


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat()


def call_row(
    loaded: LoadedConfig, record: dict[str, Any], *, source: str = "browser"
) -> dict[str, Any]:
    """The ``calls`` row for a finished call. ``record`` is the worker's call record."""
    started = float(record["started_at"])
    return {
        "account_id": loaded.account_id,
        "agent_id": loaded.agent_id,
        "agent_version_id": loaded.version_id,
        "agent_version": loaded.version,
        "room": record["room"],
        "source": source,
        "channel": channel_for(record["room"]),
        "caller_number": record.get("caller_number"),
        "started_at": _iso(started),
        "ended_at": _iso(started + float(record["duration_s"])),
        "duration_s": record["duration_s"],
        "goal_reached": bool(record["goal_reached"]),
        "transferred": bool(record["transferred"]),
        "transfer_reason": record.get("transfer_reason"),
        "recoveries": int(record.get("recoveries", 0)),
        "voice_model": record.get("voice_model"),
        "config_fingerprint": record.get("config_fingerprint"),
        "tool_calls": record.get("tool_calls", []),
        "transcript": transcript_lines(record.get("transcript", {})),
        "summary": record.get("summary"),
    }


def channel_for(room: str) -> str:
    """A website chat is typed (no minutes on the line); everything else is voice."""
    return "chat" if room.startswith("web-chat-") else "voice"


def source_for(room: str) -> str:
    """talk- is a builder test call, web- a visitor on an embedded website, else a phone call."""
    if room.startswith("talk-"):
        return "browser"
    return "web" if room.startswith("web-") else "phone"


async def save_call(
    loaded: LoadedConfig,
    record: dict[str, Any],
    *,
    creds: tuple[str, str] | None = None,
    timeout_s: float = 8.0,
) -> str | None:
    """Insert the call and return its id. None (and a log line) if it could not be saved."""
    if not loaded.agent_id or not loaded.account_id:
        return None
    creds = creds or supabase.credentials()
    if creds is None:
        return None
    url, key = creds
    headers = {
        **supabase.headers(key),
        "Prefer": "resolution=merge-duplicates,return=representation",
    }
    row = call_row(loaded, record, source=source_for(record["room"]))
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http,
            http.post(
                f"{url.rstrip('/')}/rest/v1/calls",
                params={"on_conflict": "room,started_at"},
                data=json.dumps(row, default=str),
                headers=headers,
            ) as r,
        ):
            if r.status >= 300:
                log.error("saving the call failed: HTTP %s %s", r.status, (await r.text())[:200])
                return None
            rows = await r.json()
    except (aiohttp.ClientError, TimeoutError, ValueError):
        log.exception("saving the call failed")
        return None
    return str(rows[0]["id"]) if rows else None


async def mark_synced(
    call_id: str,
    *,
    contact_id: str | None,
    error: str | None,
    creds: tuple[str, str] | None = None,
    timeout_s: float = 8.0,
) -> None:
    """Record the outcome of the Votel sync on the call. Never raises."""
    creds = creds or supabase.credentials()
    if creds is None:
        return
    url, key = creds
    patch = {
        "votel_contact_id": contact_id,
        "votel_synced_at": datetime.now(UTC).isoformat() if error is None else None,
        "votel_error": error[:300] if error else None,
    }
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http,
            http.patch(
                f"{url.rstrip('/')}/rest/v1/calls",
                params={"id": f"eq.{call_id}"},
                json=patch,
                headers={**supabase.headers(key), "Prefer": "return=minimal"},
            ) as r,
        ):
            if r.status >= 300:
                log.error("marking the call synced failed: HTTP %s", r.status)
    except (aiohttp.ClientError, TimeoutError):
        log.exception("marking the call synced failed")


async def account_contact(
    account_id: str, *, creds: tuple[str, str] | None = None, timeout_s: float = 8.0
) -> str | None:
    """The Votel contact this client (workspace) is linked to, if any. Never raises."""
    creds = creds or supabase.credentials()
    if creds is None:
        return None
    url, key = creds
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http,
            http.get(
                f"{url.rstrip('/')}/rest/v1/accounts",
                params={"id": f"eq.{account_id}", "select": "votel_contact_id"},
                headers=supabase.headers(key),
            ) as r,
        ):
            if r.status >= 300:
                return None
            rows = await r.json()
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return None
    return (rows[0].get("votel_contact_id") or None) if rows else None


async def call_synced(
    call_id: str, *, creds: tuple[str, str] | None = None, timeout_s: float = 8.0
) -> bool:
    """True if this call was already sent to Votel (a retry must not send it twice). Never raises."""
    creds = creds or supabase.credentials()
    if creds is None:
        return False
    url, key = creds
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http,
            http.get(
                f"{url.rstrip('/')}/rest/v1/calls",
                params={"id": f"eq.{call_id}", "select": "votel_synced_at"},
                headers=supabase.headers(key),
            ) as r,
        ):
            if r.status >= 300:
                return False
            rows = await r.json()
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return False
    return bool(rows and rows[0].get("votel_synced_at"))
