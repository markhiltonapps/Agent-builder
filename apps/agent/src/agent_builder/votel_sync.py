"""After a call: put it in Votel's CRM.

For a call that has a caller we can identify (a phone number from the line or given to
``take_message``): find or create the contact, add a note with the summary, the outcome and a
link to the transcript, and create a task when someone must call back or take over.

A browser test call is not sent unless ``VOTEL_SYNC_TEST_CALLS=1``, so testing never fills the
CRM. Everything here is best effort: a Votel problem is recorded on the call and logged, never
raised into the call.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

from .loader import LoadedConfig
from .votel import VotelConfig, VotelError, call_tool, first_id

log = logging.getLogger("agent_builder.votel_sync")


@dataclass
class SyncResult:
    contact_id: str | None = None
    error: str | None = None
    skipped: str | None = None


def normalize_phone(raw: str | None) -> str | None:
    """+15125550100 from '(512) 555-0100', '512-555-0100', '1 512 555 0100' or '+15125550100'."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if raw.strip().startswith("+") and 8 <= len(digits) <= 15:
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return None


def _message(record: dict[str, Any]) -> dict[str, str] | None:
    for call in reversed(record.get("tool_calls", [])):
        if call.get("tool") == "take_message" and call.get("ok"):
            return {k: str(v) for k, v in call.get("args", {}).items()}
    return None


def _clock(seconds: float) -> str:
    s = round(seconds)
    return f"{s // 60}:{s % 60:02d}"


def note_text(
    loaded: LoadedConfig, record: dict[str, Any], call_id: str | None, app_url: str | None
) -> str:
    persona = loaded.config.persona
    msg = _message(record)
    outcome = (
        "transferred to a person"
        if record.get("transferred")
        else "message taken"
        if msg
        else "completed its goal"
        if record.get("goal_reached")
        else "ended"
    )
    lines = [
        (
            f"Call with {persona.agent_name} ({persona.business_name}), version {loaded.version}. "
            f"{_clock(record['duration_s'])} long. Outcome: {outcome}."
        )
    ]
    if record.get("summary"):
        lines += ["", f"Summary: {record['summary']}"]
    if msg:
        lines += ["", "Message left:"] + [f"- {k.replace('_', ' ')}: {v}" for k, v in msg.items()]
    if record.get("transfer_reason"):
        lines += ["", f"Transfer reason: {record['transfer_reason']}"]
    if call_id and app_url:
        lines += ["", f"Full transcript: {app_url.rstrip('/')}/calls/{call_id}"]
    return "\n".join(lines)


async def sync_call(
    cfg: VotelConfig,
    loaded: LoadedConfig,
    record: dict[str, Any],
    call_id: str | None,
    *,
    source: str,
    app_url: str | None = None,
) -> SyncResult:
    """Send one finished call to Votel. Never raises."""
    if source == "browser" and os.getenv("VOTEL_SYNC_TEST_CALLS") != "1":
        return SyncResult(skipped="test call")
    msg = _message(record)
    phone = normalize_phone(record.get("caller_number")) or normalize_phone(
        (msg or {}).get("phone")
    )
    if not phone:
        return SyncResult(skipped="no caller number")

    persona = loaded.config.persona
    try:
        name = (msg or {}).get("name", "").strip()
        first, _, last = name.partition(" ")
        contact: dict[str, Any] = {"phone": phone, "tags": ["voice-agent"]}
        if first:
            contact["first_name"] = first
        if last:
            contact["last_name"] = last
        contact_id = first_id(await call_tool(cfg, "create_contact", contact))
        if not contact_id:
            return SyncResult(error="Votel did not return a contact id")

        body = note_text(loaded, record, call_id, app_url)
        await call_tool(
            cfg,
            "add_note",
            {
                "contact_id": contact_id,
                "subject": f"Voice call: {persona.agent_name}",
                "note": body,
            },
        )
        if msg or record.get("transferred"):
            who = name or phone
            reason = (
                (msg or {}).get("reason") or record.get("transfer_reason") or "see the call note"
            )
            await call_tool(
                cfg,
                "create_task",
                {
                    "title": f"{'Take over' if record.get('transferred') else 'Call back'} {who}: {reason}"[
                        :200
                    ],
                    "description": body,
                    "lead_id": contact_id,
                    "priority": "high" if record.get("transferred") else "medium",
                },
            )
    except VotelError as e:
        log.warning("Votel sync failed: %s", e)
        return SyncResult(contact_id=locals().get("contact_id"), error=str(e))
    return SyncResult(contact_id=contact_id)
