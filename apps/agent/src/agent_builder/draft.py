"""AI help for writing agents: draft a new one from a description, or revise an existing one.

The model writes the conversation parts of an ``AgentConfig`` (persona, greetings, rules,
escalation, flows). It never touches the parts with consequences: a new agent starts with no
tools and no adapters, and a revision keeps the existing tools, adapters and runtime exactly.
Everything it returns is validated by the same ``AgentConfig`` the worker runs; a draft that
fails validation is sent back to the model with the errors, twice at most.

No model name lives here: ``DRAFT_MODEL`` names it (a default is set below for convenience).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aiohttp
from pydantic import ValidationError

from .config import AgentConfig

DEFAULT_MODEL = "gpt-5.2"
MAX_ATTEMPTS = 3
EXAMPLE = Path(__file__).resolve().parents[2] / "templates" / "home_services.json"

SYSTEM = """You write the configuration for phone voice agents. Reply with ONE JSON object of \
the form {"config": {...}, "summary": "one plain sentence about what you did"} and nothing else.

"config" must match this JSON Schema exactly (no extra keys):
__SCHEMA__

How to write it:
- persona.agent_name is a first name that suits the business. persona.business_description \
states hours, services and service area ONLY if the user gave them. Never invent phone numbers, \
prices, addresses, hours or policies. If something is unknown, write the agent so it takes a \
message and says someone will follow up, instead of guessing.
- greetings are short spoken lines. They may use only the placeholders {business} and \
{agent_name}.
- guardrails: 4 to 8 firm rules on what the agent must never promise, quote or advise \
(safety, legal, medical, pricing, payments, personal data).
- escalation: 2 to 4 rules. Emergencies and safety first (transfer), upset callers or requests \
for a person (transfer), questions it cannot answer such as billing, legal or medical (take_message).
- policy.speaking_rules: a few extra phone-speaking rules specific to this business.
- policy.backend_flows: numbered step lists for the 2 to 4 most common calls. Where the agent \
cannot do something itself, it collects the caller's name and phone number (reading the number \
back) and the reason, then records it with its take_message tool.
- The agent has two built-in tools, take_message and transfer_to_human, and NO other tools. \
Leave "tools" and "adapters" empty and leave "runtime" out.
- Limits: every guardrail, every escalation condition and every greeting is at most 200 \
characters; each handoff_summary at most 300; business_description at most 1000. Keep them well under.
- Write for the ear: short sentences, plain words, no markdown, no lists inside spoken lines.

For format and level of detail only (do not copy its content), here is a finished config for a \
home-services company:
__EXAMPLE__"""

REVISE = """

You are EDITING an existing agent. You are given its current config and an instruction. Return \
the complete updated config, changing only what the instruction asks and keeping everything \
else exactly as it is. Never change tools, adapters or runtime. In "summary", say in one plain \
sentence what you changed."""


class DraftError(Exception):
    """The draft could not be produced. The message is safe to show the user."""


@dataclass
class Draft:
    config: dict[str, Any]
    summary: str
    attempts: int = 1
    notes: list[str] = field(default_factory=list)


def _system(revise: bool) -> str:
    schema = json.dumps(AgentConfig.model_json_schema(), separators=(",", ":"))
    example = json.dumps(json.loads(EXAMPLE.read_text()), separators=(",", ":"))
    text = SYSTEM.replace("__SCHEMA__", schema).replace("__EXAMPLE__", example)
    return text + (REVISE if revise else "")


def _errors(e: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in err['loc']) or 'config'}: {err['msg']}"
        for err in e.errors(include_url=False)
    )[:1500]


async def _ask(
    http: aiohttp.ClientSession, base: str, key: str, model: str, messages: list[dict]
) -> str:
    try:
        async with http.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "messages": messages, "response_format": {"type": "json_object"}},
        ) as r:
            if r.status in (401, 403):
                raise DraftError("AI help isn't set up correctly on this server. Contact Neato.")
            if r.status == 429:
                raise DraftError("The AI service is busy right now. Try again in a minute.")
            if r.status >= 400:
                raise DraftError("The AI service could not take the request. Try again.")
            body = await r.json()
    except (aiohttp.ClientError, TimeoutError) as e:
        raise DraftError("Could not reach the AI service. Try again.") from e
    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise DraftError("The AI service sent back something unexpected. Try again.") from e


def _finish(raw: dict[str, Any], existing: dict[str, Any] | None) -> AgentConfig:
    cfg = dict(raw)
    if existing is None:
        cfg.update(tools=[], adapters={})
        cfg.pop("runtime", None)
    else:  # the parts with consequences are never the model's to change
        for key in ("tools", "adapters", "runtime", "schema_version"):
            if key in existing:
                cfg[key] = existing[key]
            else:
                cfg.pop(key, None)
    return AgentConfig.model_validate(cfg)


async def draft(
    request: str,
    *,
    existing: dict[str, Any] | None = None,
    key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    timeout_s: float = 120.0,
) -> Draft:
    """Draft a new agent from ``request``, or revise ``existing`` as ``request`` says."""
    key = key or os.getenv("OPENAI_API_KEY", "")
    if not key:
        raise DraftError("AI help isn't set up on this server yet. Contact Neato.")
    model = model or os.getenv("DRAFT_MODEL") or DEFAULT_MODEL
    base = (base_url or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")

    user = (
        f"CURRENT CONFIG:\n{json.dumps(existing)}\n\nINSTRUCTION:\n{request}"
        if existing is not None
        else f"Write an agent for this business:\n{request}"
    )
    messages: list[dict] = [
        {"role": "system", "content": _system(existing is not None)},
        {"role": "user", "content": user},
    ]
    problem = ""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            content = await _ask(http, base, key, model, messages)
            try:
                envelope = json.loads(content)
                raw = envelope["config"]
                cfg = _finish(raw, existing)
                return Draft(
                    config=cfg.model_dump(mode="json"),
                    summary=str(envelope.get("summary", "")).strip()[:300],
                    attempts=attempt,
                )
            except ValidationError as e:  # before ValueError, which it is a kind of
                problem = _errors(e)
            except (ValueError, KeyError, TypeError) as e:
                problem = f"that was not valid JSON of the required shape ({type(e).__name__})"
            messages += [
                {"role": "assistant", "content": content},
                {
                    "role": "user",
                    "content": f"That failed validation: {problem}. Return the complete corrected "
                    'JSON object ({"config": ..., "summary": ...}) and nothing else.',
                },
            ]
    raise DraftError(
        "The AI could not produce a valid agent from that. Try describing it differently."
    )
