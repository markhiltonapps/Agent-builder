"""Is each voice provider reachable right now? For the "Voice status" line in the app, so a demo
can start with a glance at it. It asks each provider whether the key works and the model exists:
a good sign, not a promise that a call will go well."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import aiohttp

from .config import GOOGLE_MODEL, ModelSpec
from .voice_failover import has_credentials

GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta"


async def _probe(http: aiohttp.ClientSession, url: str, headers: dict[str, str]) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        async with http.get(url, headers=headers) as r:
            ms = int((time.perf_counter() - started) * 1000)
            return {"ok": r.status == 200, "status": r.status, "ms": ms}
    except TimeoutError:
        return {"ok": False, "status": "timeout", "ms": int((time.perf_counter() - started) * 1000)}
    except aiohttp.ClientError as e:
        return {"ok": False, "status": type(e).__name__, "ms": 0}


async def check(
    env: dict[str, str] | None = None,
    *,
    openai_base: str | None = None,
    google_base: str | None = None,
) -> dict[str, Any]:
    env = os.environ if env is None else env
    openai_url = (openai_base or env.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip(
        "/"
    )
    key = env.get("OPENAI_API_KEY", "").strip()
    gkey = (env.get("GEMINI_API_KEY") or env.get("GOOGLE_API_KEY") or "").strip()
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6)) as http:
        openai_task = _probe(
            http, f"{openai_url}/models/gpt-live-1", {"Authorization": f"Bearer {key}"}
        )
        if has_credentials(ModelSpec(provider="google"), env):
            google_task = _probe(
                http,
                f"{(google_base or GOOGLE_BASE).rstrip('/')}/models/{GOOGLE_MODEL}",
                {"x-goog-api-key": gkey},
            )
            openai, google = await asyncio.gather(openai_task, google_task)
            google = {"configured": True, **google}
        else:
            openai = await openai_task
            google = {"configured": False, "ok": False}
    failover_on = google["configured"] and env.get("VOICE_FAILOVER", "on").strip().lower() != "off"
    return {
        "primary": {"name": "OpenAI GPT-Live", **openai},
        "backup": {"name": "Google Gemini Live", **google},
        "failover": bool(failover_on),
    }
