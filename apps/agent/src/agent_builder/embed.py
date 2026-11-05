"""Website embed: who may start a call with an agent, and counting those calls.

The web app asks this module (through the builder API) two questions: what is the embed's
public face and which websites may show it (``info``), and may one more call start now
(``begin``). Both use the project's secret key; neither is reachable from the internet.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import aiohttp

from . import supabase
from .votel import UUID

log = logging.getLogger("agent_builder.embed")


class EmbedError(Exception):
    """The database could not be reached or refused the request."""


@dataclass(frozen=True)
class EmbedInfo:
    name: str
    business: str
    enabled: bool
    origins: list[str]
    published: bool
    voice: bool = True
    chat: bool = True

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "business": self.business,
            "enabled": self.enabled,
            "origins": self.origins,
            "published": self.published,
            "voice": self.voice,
            "chat": self.chat,
        }


def valid_agent_id(value: str) -> bool:
    return bool(UUID.fullmatch(value))


async def info(agent_id: str, *, creds: tuple[str, str] | None = None) -> EmbedInfo | None:
    """The embed settings and public name for an agent, or None if there is no such agent."""
    if not valid_agent_id(agent_id):
        return None
    creds = creds or supabase.credentials()
    if creds is None:
        raise EmbedError("database is not configured")
    url, key = creds
    base = url.rstrip("/") + "/rest/v1"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as http:
            async with http.get(
                f"{base}/agents",
                params={
                    "id": f"eq.{agent_id}",
                    "select": "name,embed_enabled,embed_origins,published_version_id,embed_voice,embed_chat",
                },
                headers=supabase.headers(key),
            ) as r:
                if r.status >= 300:
                    raise EmbedError(f"database said {r.status}")
                rows = await r.json()
            if not rows:
                return None
            agent = rows[0]
            business = ""
            if agent.get("published_version_id"):
                async with http.get(
                    f"{base}/agent_versions",
                    params={
                        "id": f"eq.{agent['published_version_id']}",
                        "select": "persona:config->persona",
                    },
                    headers=supabase.headers(key),
                ) as r:
                    if r.status < 300:
                        versions = await r.json()
                        persona = (versions[0].get("persona") if versions else None) or {}
                        business = str(persona.get("business_name") or "")
    except (aiohttp.ClientError, TimeoutError, ValueError) as e:
        log.warning("embed info failed: %s", e)
        raise EmbedError("database is unreachable") from e
    return EmbedInfo(
        name=str(agent["name"]),
        business=business,
        enabled=bool(agent.get("embed_enabled")),
        origins=[str(o) for o in agent.get("embed_origins") or []],
        published=bool(agent.get("published_version_id")),
        voice=agent.get("embed_voice") is not False,
        chat=agent.get("embed_chat") is not False,
    )


async def begin(agent_id: str, kind: str = "voice", *, creds: tuple[str, str] | None = None) -> str:
    """Count one embedded call or chat (``kind`` is "voice" or "chat"). 'ok', 'disabled', 'unpublished' or 'limit'."""
    if not valid_agent_id(agent_id):
        return "disabled"
    creds = creds or supabase.credentials()
    if creds is None:
        raise EmbedError("database is not configured")
    url, key = creds
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as http,
            http.post(
                f"{url.rstrip('/')}/rest/v1/rpc/embed_begin",
                data=json.dumps(
                    {"p_agent": agent_id, "p_kind": "chat" if kind == "chat" else "voice"}
                ),
                headers=supabase.headers(key),
            ) as r,
        ):
            if r.status >= 300:
                raise EmbedError(f"database said {r.status}")
            result = await r.json()
    except (aiohttp.ClientError, TimeoutError, ValueError) as e:
        log.warning("embed begin failed: %s", e)
        raise EmbedError("database is unreachable") from e
    return result if result in {"ok", "disabled", "unpublished", "limit"} else "disabled"
