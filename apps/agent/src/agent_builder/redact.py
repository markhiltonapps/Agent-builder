"""Keep card details out of what is saved.

A caller may read a card number to an agent (the demo hotel takes test-card payments). The number has to
reach the payment step, but it must not be kept in a transcript, a call record, a saved conversation or a
CRM note. Everything that stores what was said or done goes through these functions first. They are
deliberately generous: a long run of digits (or spoken digits) is a card number, and anything named like a
card number or security code is masked, so a real card is never written down even if someone uses one.
"""

from __future__ import annotations

import json
import re
from typing import Any

_WORD = r"(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)"
_DIGITS = re.compile(r"(?<!\d)(?:\d[ \-.]?){12,18}\d(?!\d)")
_SPOKEN = re.compile(rf"\b(?:{_WORD}[\s,.\-]+){{11,}}{_WORD}\b", re.IGNORECASE)
_CODE = re.compile(
    rf"\b(cvv2?|cvc2?|security code|verification code|card code)\b(\W{{0,14}}(?:\b(?:is|are|was)\b\W{{0,6}})?)(\d[\d \-]{{1,6}}|(?:{_WORD}[\s,.\-]*){{2,4}})",
    re.IGNORECASE,
)
_SECRET_KEY = re.compile(r"(card.?number|^number$|cvv|cvc|security.?code|^pan$)", re.IGNORECASE)
_EXPIRY_KEY = re.compile(r"(expir|exp.?date)", re.IGNORECASE)

REMOVED = "[card number removed]"


def mask_card(number: str) -> str:
    digits = re.sub(r"\D", "", number)
    return f"•••• {digits[-4:]}" if len(digits) >= 4 else "••••"


def redact_text(text: str) -> str:
    """The text with any card number or security code taken out."""
    text = _DIGITS.sub(REMOVED, text)
    text = _SPOKEN.sub(REMOVED, text)
    return _CODE.sub(lambda m: f"{m.group(1)}{m.group(2)}[removed]", text)


def redact_data(value: Any, key: str = "") -> Any:
    """The same for a nested structure (a tool's arguments or result): secret-looking fields are masked."""
    if isinstance(value, dict):
        return {k: redact_data(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_data(v, key) for v in value]
    if isinstance(value, str):
        if _SECRET_KEY.search(key):
            if "•" in value:
                return value  # already masked
            return mask_card(value) if re.sub(r"\D", "", value).__len__() >= 12 else "•••"
        if _EXPIRY_KEY.search(key):
            return "••/••"
        return redact_text(value)
    if isinstance(value, int | float) and not isinstance(value, bool) and _SECRET_KEY.search(key):
        return mask_card(str(value)) if len(str(value)) >= 12 else "•••"
    return value


def redact_chat(chat: dict[str, Any]) -> dict[str, Any]:
    """A saved conversation (``ChatContext.to_dict()``) with card details removed from every message and
    every tool call in it."""

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if k == "arguments" and isinstance(v, str) or k == "output" and isinstance(v, str):
                    try:
                        out[k] = json.dumps(redact_data(json.loads(v)))
                    except ValueError:
                        out[k] = redact_text(v)
                else:
                    out[k] = walk(v)
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, str):
            return redact_text(node)
        return node

    return walk(chat)
