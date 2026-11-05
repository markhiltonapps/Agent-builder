"""A short plain-English summary of a finished call, for the call list and the CRM note.

Best effort: a call is never lost or delayed for want of a summary. ``SUMMARY_MODEL`` names
the model (a default is set for convenience); the key is the worker's ``OPENAI_API_KEY``.
"""

from __future__ import annotations

import logging
import os

import aiohttp

log = logging.getLogger("agent_builder.summary")

DEFAULT_MODEL = "gpt-6-luna"
SYSTEM = (
    "You summarize phone calls between an AI receptionist and a caller for a busy business "
    "owner. In two or three plain sentences say why the caller phoned, what the agent did or "
    "decided, and any follow-up a person needs to do. Use only what is in the transcript. "
    "Do not invent names, numbers or details."
)


def transcript_text(lines: list[dict[str, str]], limit: int = 12000) -> str:
    text = "\n".join(f"{'Caller' if l['who'] == 'caller' else 'Agent'}: {l['text']}" for l in lines)
    return text[-limit:]  # a very long call: keep the end, where the outcome is


async def summarize(
    lines: list[dict[str, str]],
    *,
    key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    timeout_s: float = 15.0,
) -> str | None:
    """A summary, or None if there is nothing to summarize or it could not be made."""
    key = key or os.getenv("OPENAI_API_KEY", "")
    if not key or sum(1 for l in lines if l["who"] == "caller") == 0:
        return None
    base = (base_url or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    body = {
        "model": model or os.getenv("SUMMARY_MODEL") or DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": transcript_text(lines)},
        ],
    }
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http,
            http.post(
                f"{base}/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"}
            ) as r,
        ):
            if r.status >= 300:
                log.warning("summary failed: HTTP %s", r.status)
                return None
            data = await r.json()
        text = str(data["choices"][0]["message"]["content"]).strip()
    except (aiohttp.ClientError, TimeoutError, KeyError, IndexError, TypeError, ValueError):
        log.warning("summary failed", exc_info=True)
        return None
    return text[:1500] or None
