"""Startup checks for the worker's keys.

Pasting a key into a hosting dashboard often brings along a trailing space, a newline or
quote marks. They are invisible in the UI and make the provider answer 401, and the voice
library reports that only as "connection error". ``clean_env`` removes them and
``preflight`` asks each service whether the key works. Output carries status codes, lengths
and flags only; never a key or any part of one.
"""

from __future__ import annotations

import asyncio
import os

import aiohttp

KEYS = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "OPENAI_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
)


def _tidy(value: str) -> str:
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v


def clean_env(env: dict[str, str] | None = None) -> list[str]:
    """Trim whitespace and wrapping quotes from the key variables. Returns names changed."""
    env = os.environ if env is None else env
    changed = []
    for name in KEYS:
        raw = env.get(name)
        if raw is None:
            continue
        fixed = _tidy(raw)
        if fixed != raw:
            env[name] = fixed
            changed.append(name)
    return changed


def _flags(name: str, env: dict[str, str]) -> str:
    v = env.get(name, "")
    return f"{name}: set={bool(v)} length={len(v)} has_space={any(c.isspace() for c in v)}"


async def _status(http: aiohttp.ClientSession, method: str, url: str, **kw: object) -> str:
    try:
        async with http.request(method, url, **kw) as r:  # type: ignore[arg-type]
            return str(r.status)
    except TimeoutError:
        return "timeout"
    except aiohttp.ClientError as e:
        return f"error:{type(e).__name__}"


async def preflight(
    env: dict[str, str] | None = None, *, openai_base: str | None = None
) -> list[str]:
    """Check the keys against their services. Returns report lines (also printed)."""
    env = os.environ if env is None else env
    lines = [_flags(n, env) for n in KEYS]
    base = (openai_base or env.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        key = env.get("OPENAI_API_KEY", "")
        auth = {"Authorization": f"Bearer {key}"} if key else {}
        lines.append(
            f"openai key (GET /models): {await _status(http, 'GET', f'{base}/models', headers=auth)}"
        )
        model = "gpt-live-1"
        lines.append(
            f"openai model {model} (GET /models/{model}): "
            f"{await _status(http, 'GET', f'{base}/models/{model}', headers=auth)}"
        )
        url, sk = env.get("SUPABASE_URL", ""), env.get("SUPABASE_SECRET_KEY", "")
        if url and sk:
            h = {"apikey": sk, "Content-Type": "application/json"}
            if not sk.startswith("sb_"):
                h["Authorization"] = f"Bearer {sk}"
            lines.append(
                "supabase secret key (rpc published_agent): "
                + await _status(
                    http,
                    "POST",
                    f"{url.rstrip('/')}/rest/v1/rpc/published_agent",
                    headers=h,
                    json={"p_agent": "00000000-0000-0000-0000-000000000000"},
                )
            )
    for line in lines:
        print(f"[preflight] {line}", flush=True)
    return lines


def run() -> None:
    changed = clean_env()
    if changed:
        print(f"[preflight] trimmed whitespace/quotes from: {', '.join(changed)}", flush=True)
    try:
        asyncio.run(preflight())
    except Exception as e:  # noqa: BLE001  a failed check must never stop the worker
        print(f"[preflight] could not run: {type(e).__name__}", flush=True)
