"""Let an agent look things up on the web, the way a person would search: "golf courses near the hotel".

The search is Google's, through the Gemini API's "grounding with Google Search": Gemini searches, reads what it
finds and writes a short spoken-style answer, with the names of the pages it used. If that cannot answer (no key, an
outage, a model that is not available) the same question goes to OpenAI's web search. Either way the agent gets back
two or three plain sentences and the sources, to say aloud.

Settings live on the agent (``web_search``: on or off, where the business is, how many searches a call may make).
Search results are information for the agent to report; the instructions tell it never to follow anything written
in them. Costs: Google gives 5,000 searches a month free, then $14 per 1,000; OpenAI's is $10 per 1,000.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

import aiohttp

log = logging.getLogger("agent_builder.web_search")

GEMINI_MODELS = ("gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-2.5-flash")
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
OPENAI_BASE = "https://api.openai.com/v1"
MAX_QUERY_CHARS = 200
MAX_ANSWER_CHARS = 700

STYLE = (
    "You answer a question for a receptionist who will read your answer aloud to a caller. Search the web and "
    "answer in two or three short, plain sentences: names, distances, opening hours and prices where you found "
    "them. No markdown, no lists, no links, no filler. If you cannot find a reliable answer, say so in one sentence."
)


class SearchError(Exception):
    """The web could not be searched just now."""


@dataclass
class WebAnswer:
    text: str
    sources: list[str] = field(default_factory=list)
    engine: str = ""


def _clean(text: str) -> str:
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[*_`#>]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_ANSWER_CHARS]


def _prompt(query: str, location: str) -> str:
    where = f"\nThe caller is asking about the area of: {location}." if location.strip() else ""
    return f"Question: {query.strip()[:MAX_QUERY_CHARS]}{where}"


async def _gemini(query: str, location: str, key: str, base: str, timeout_s: float) -> WebAnswer:
    models = [m for m in (os.getenv("WEB_SEARCH_MODEL"), *GEMINI_MODELS) if m]
    last: str = "no model answered"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http:
        for model in dict.fromkeys(models):
            body = {
                "systemInstruction": {"parts": [{"text": STYLE}]},
                "contents": [{"role": "user", "parts": [{"text": _prompt(query, location)}]}],
                "tools": [{"google_search": {}}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 500},
            }
            try:
                async with http.post(
                    f"{base}/models/{model}:generateContent",
                    json=body,
                    headers={"x-goog-api-key": key},
                ) as r:
                    if r.status in (400, 404):
                        last = f"{model}: HTTP {r.status}"
                        continue  # this model is not available here; try the next
                    if r.status >= 300:
                        raise SearchError(f"Gemini said HTTP {r.status}")
                    data = await r.json()
            except (aiohttp.ClientError, TimeoutError) as e:
                raise SearchError(f"Gemini unreachable: {e}") from e
            cand = (data.get("candidates") or [{}])[0]
            parts = (cand.get("content") or {}).get("parts") or []
            text = _clean(" ".join(str(p.get("text", "")) for p in parts if isinstance(p, dict)))
            if not text:
                last = f"{model}: empty answer"
                continue
            chunks = (cand.get("groundingMetadata") or {}).get("groundingChunks") or []
            titles = [str((c.get("web") or {}).get("title") or "").strip() for c in chunks]
            return WebAnswer(
                text, list(dict.fromkeys(t for t in titles if t))[:3], f"google:{model}"
            )
    raise SearchError(last)


async def _openai(query: str, location: str, key: str, base: str, timeout_s: float) -> WebAnswer:
    body: dict[str, Any] = {
        "model": os.getenv("WEB_SEARCH_OPENAI_MODEL") or os.getenv("CHAT_MODEL") or "gpt-6-luna",
        "instructions": STYLE,
        "input": _prompt(query, location),
        "tools": [{"type": "web_search"}],
        "max_output_tokens": 600,
    }
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http,
            http.post(
                f"{base}/responses", json=body, headers={"Authorization": f"Bearer {key}"}
            ) as r,
        ):
            if r.status >= 300:
                raise SearchError(f"OpenAI said HTTP {r.status}")
            data = await r.json()
    except (aiohttp.ClientError, TimeoutError) as e:
        raise SearchError(f"OpenAI unreachable: {e}") from e
    texts, titles = [], []
    for item in data.get("output") or []:
        if isinstance(item, dict) and item.get("type") == "message":
            for c in item.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    texts.append(str(c.get("text") or ""))
                    for a in c.get("annotations") or []:
                        if isinstance(a, dict) and a.get("title"):
                            titles.append(str(a["title"]).strip())
    text = _clean(" ".join(texts))
    if not text:
        raise SearchError("OpenAI returned no answer")
    return WebAnswer(text, list(dict.fromkeys(titles))[:3], "openai")


async def search_web(
    query: str,
    location: str = "",
    *,
    gemini_key: str | None = None,
    openai_key: str | None = None,
    gemini_base: str = GEMINI_BASE,
    openai_base: str = OPENAI_BASE,
    timeout_s: float = 12.0,
) -> WebAnswer:
    """Search the web for ``query`` near ``location``. Raises ``SearchError`` if nothing could answer."""
    gkey = (
        gemini_key
        if gemini_key is not None
        else (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "")
    )
    okey = openai_key if openai_key is not None else os.getenv("OPENAI_API_KEY", "")
    problems: list[str] = []
    if gkey:
        try:
            return await _gemini(query, location, gkey, gemini_base, timeout_s)
        except SearchError as e:
            log.warning("Google search failed: %s", e)
            problems.append(str(e))
    if okey:
        try:
            return await _openai(query, location, okey, openai_base, timeout_s + 6)
        except SearchError as e:
            log.warning("OpenAI search failed: %s", e)
            problems.append(str(e))
    raise SearchError("; ".join(problems) or "no search key is set")
