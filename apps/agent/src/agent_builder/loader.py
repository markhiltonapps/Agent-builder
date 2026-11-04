"""Resolve which agent config a call runs.

Dispatch metadata (JSON, optional) may carry, in this order of precedence:
  {"config": {...}}                                  an inline config (tests, evals)
  {"agent_id": "<uuid>"}                             the published version of a database agent
  {"config_path": "templates/home_services.json"}   a file to load
Otherwise ``AGENT_ID`` (a worker dedicated to one agent) or ``AGENT_CONFIG`` (a file) decides,
defaulting to the home-services template.

A database agent runs exactly what its owner published. If the database cannot be reached the
worker reuses the last version it successfully loaded for that agent; it never falls back to a
different agent's template.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import aiohttp

from . import supabase
from .config import AgentConfig

log = logging.getLogger("agent_builder.loader")

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "templates" / "home_services.json"


@dataclass(frozen=True)
class LoadedConfig:
    config: AgentConfig
    source: str
    """``file``, ``inline`` or ``published``."""
    agent_id: str | None = None
    version_id: str | None = None
    version: int | None = None


@lru_cache(maxsize=64)
def _load_file(path: str, mtime: float) -> AgentConfig:
    return AgentConfig.model_validate_json(Path(path).read_text())


def load_file(path: str | Path) -> AgentConfig:
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    return _load_file(str(p), p.stat().st_mtime)


def load_config(metadata: str | None) -> AgentConfig:
    """File or inline config. Database agents go through ``resolve_config``."""
    meta = json.loads(metadata) if metadata else {}
    if "config" in meta:
        return AgentConfig.model_validate(meta["config"])
    return load_file(meta.get("config_path") or os.getenv("AGENT_CONFIG") or DEFAULT_CONFIG)


class PublishedSource:
    """Reads ``public.published_agent(agent)`` through PostgREST with the secret key."""

    def __init__(self, url: str, key: str, *, timeout_s: float = 5.0) -> None:
        self._url = f"{url.rstrip('/')}/rest/v1/rpc/published_agent"
        self._headers = supabase.headers(key)
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)
        self._last_good: dict[str, LoadedConfig] = {}

    async def load(self, agent_id: str) -> LoadedConfig:
        try:
            loaded = await self._fetch(agent_id)
        except (aiohttp.ClientError, TimeoutError):
            if agent_id in self._last_good:
                log.exception("could not reach the database; reusing last loaded %s", agent_id)
                return self._last_good[agent_id]
            raise
        self._last_good[agent_id] = loaded
        return loaded

    async def _fetch(self, agent_id: str) -> LoadedConfig:
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.post(self._url, json={"p_agent": agent_id}, headers=self._headers) as r,
        ):
            if r.status == 400:  # malformed id
                raise LookupError(f"{agent_id!r} is not a valid agent id")
            r.raise_for_status()
            rows = await r.json()
        if not rows:
            raise LookupError(f"agent {agent_id} does not exist or has no published version")
        row = rows[0]
        return LoadedConfig(
            config=AgentConfig.model_validate(row["config"]),
            source="published",
            agent_id=row["agent_id"],
            version_id=row["version_id"],
            version=row["version"],
        )


_source: PublishedSource | None = None


def published_source() -> PublishedSource:
    global _source
    creds = supabase.credentials()
    if creds is None:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY are needed to load an agent_id")
    if _source is None:
        _source = PublishedSource(*creds)
    return _source


async def resolve_config(metadata: str | None) -> LoadedConfig:
    meta = json.loads(metadata) if metadata else {}
    if "config" in meta:
        return LoadedConfig(load_config(metadata), "inline")
    agent_id = meta.get("agent_id") or (None if meta.get("config_path") else os.getenv("AGENT_ID"))
    if agent_id:
        return await published_source().load(str(agent_id))
    return LoadedConfig(load_config(metadata), "file")
