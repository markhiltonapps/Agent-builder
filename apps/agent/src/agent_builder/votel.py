"""Talk to Votel.ai through its hosted MCP endpoint, authenticated with an API key.

Votel's MCP server (``<api>/mcp``, streamable HTTP) exposes the whole workspace as tools:
contacts, notes, tasks, bookings, messaging, the CMS. It accepts ``Authorization: Bearer
sk_...``, which is also how Votel's own ``mycrm-mcp`` package connects. Each call here opens a
short session, runs one tool and closes it: simple and robust, and fast enough for after-call
work.

The key lives in the environment (``VOTEL_API_KEY``), never in an agent config.
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

DEFAULT_API_URL = "https://agency.neatoventures.com"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)


class VotelError(Exception):
    """A Votel call failed. The message is for logs, not for callers."""


@dataclass(frozen=True)
class VotelConfig:
    key: str
    api_url: str = DEFAULT_API_URL

    @property
    def mcp_url(self) -> str:
        return f"{self.api_url.rstrip('/')}/mcp"


def votel_config() -> VotelConfig | None:
    key = (os.getenv("VOTEL_API_KEY") or "").strip()
    if not key:
        return None
    return VotelConfig(key=key, api_url=(os.getenv("VOTEL_API_URL") or DEFAULT_API_URL).strip())


@asynccontextmanager
async def _session(cfg: VotelConfig, timeout_s: float) -> AsyncIterator[ClientSession]:
    headers = {"Authorization": f"Bearer {cfg.key}", "X-MCP-Client": "neato-agent-builder"}
    async with (
        create_mcp_http_client(headers=headers, timeout=httpx.Timeout(timeout_s)) as http,
        streamable_http_client(cfg.mcp_url, http_client=http) as (r, w, _),
        ClientSession(r, w) as session,
    ):
        await session.initialize()
        yield session


def _text(result: Any) -> str:
    return "\n".join(c.text for c in result.content if getattr(c, "type", None) == "text")


async def call_tool(
    cfg: VotelConfig, name: str, args: dict[str, Any], *, timeout_s: float = 20
) -> str:
    """Run one Votel tool and return its text. Raises ``VotelError`` on any failure."""
    try:
        async with asyncio.timeout(timeout_s), _session(cfg, timeout_s) as session:
            result = await session.call_tool(name, args)
    except TimeoutError as e:
        raise VotelError(f"{name}: timed out") from e
    except Exception as e:  # transport errors arrive wrapped in exception groups
        raise VotelError(f"{name}: {_reason(e)}") from e
    text = _text(result)
    if result.isError or text.lstrip().startswith("Error:"):
        raise VotelError(f"{name}: {text[:300]}")
    return text


async def list_tool_names(cfg: VotelConfig, *, timeout_s: float = 15) -> list[str]:
    try:
        async with asyncio.timeout(timeout_s), _session(cfg, timeout_s) as session:
            return sorted(t.name for t in (await session.list_tools()).tools)
    except TimeoutError as e:
        raise VotelError("list_tools: timed out") from e
    except Exception as e:
        raise VotelError(f"list_tools: {_reason(e)}") from e


def _reason(e: BaseException) -> str:
    """The innermost cause, which is what an exception group hides behind its summary."""
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    text = str(e)
    return f"{type(e).__name__}: {text[:200]}" if text else type(e).__name__


def first_id(text: str) -> str | None:
    """The first UUID in a tool's reply: Votel reports ids in plain text."""
    m = UUID.search(text)
    return m.group(0) if m else None
