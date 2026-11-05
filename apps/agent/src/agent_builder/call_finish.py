"""Everything that happens once a call or chat is over.

Shared by the voice worker and website chat: summarize it, save it to the database, send it to
Votel, and note it on the client's own Votel contact. Every step is best effort: nothing here
may raise into a call or a chat.
"""

from __future__ import annotations

import logging
import os

from .calls_store import (
    account_contact,
    call_synced,
    mark_synced,
    save_call,
    source_for,
    transcript_lines,
)
from .summary import summarize
from .votel import votel_config
from .votel_clients import note_call
from .votel_sync import sync_call

log = logging.getLogger("agent_builder.call_finish")


async def note_on_client(cfg, loaded, record: dict, call_id: str) -> None:
    """A one-line note on the client's own Votel contact, when this client is linked to one."""
    try:
        contact = await account_contact(loaded.account_id) if loaded.account_id else None
        if not contact:
            return
        base = (os.getenv("APP_URL") or "").rstrip("/")
        summary = " ".join(str(record.get("summary") or "").split())[:240]
        outcome = "Handed off to a person." if record.get("transferred") else summary
        await note_call(
            cfg,
            contact,
            agent=loaded.config.persona.agent_name,
            outcome=outcome,
            link=f"{base}/calls/{call_id}" if base else "",
        )
    except Exception:
        log.exception("noting the call on the client failed")


SUMMARY_TRIES = 3
"""A missing summary is retried this many times in all; after that the call goes on without one."""


def _expects_summary(record: dict) -> bool:
    """Whether a summary could have been made: a key is set and the caller said something."""
    lines = transcript_lines(record.get("transcript", {}))
    return bool(os.getenv("OPENAI_API_KEY")) and any(l["who"] == "caller" for l in lines)


async def process_call(loaded, record: dict, *, attempt: int = 0) -> str | None:
    """Save the call, summarize it, send it to Votel. Safe to run again after any failure.

    Returns None when everything is done (or cannot be done at all, such as no Votel connection),
    otherwise a short reason to try again later. Never raises. The call is saved first, before the
    slow steps, so it shows under Calls straight away; each step then checks what an earlier
    attempt already did, so a retry never sends the same call to Votel twice.
    """
    try:
        call_id = await save_call(loaded, record)
        if call_id is None:
            return "the call could not be saved"
        log.info("call saved to the database")
        if not record.get("summary"):
            summary = await summarize(transcript_lines(record["transcript"]))
            if summary:
                record["summary"] = summary
                if await save_call(loaded, record) is None:
                    return "the summary could not be saved"
            elif _expects_summary(record) and attempt + 1 < SUMMARY_TRIES:
                return "no summary yet"
        cfg = votel_config()
        if cfg is None:
            return None
        if attempt > 0 and await call_synced(call_id):
            return None
        result = await sync_call(
            cfg,
            loaded,
            record,
            call_id,
            source=source_for(record["room"]),
            app_url=os.getenv("APP_URL"),
        )
        if result.skipped:
            log.info("not sent to Votel: %s", result.skipped)
            return None
        if result.error is not None:
            await mark_synced(call_id, contact_id=result.contact_id, error=result.error)
            log.warning("Votel sync failed: %s", result.error)
            return f"Votel: {result.error}"[:300]
        await note_on_client(cfg, loaded, record, call_id)
        await mark_synced(call_id, contact_id=result.contact_id, error=None)
        log.info("sent to Votel")
        return None
    except Exception as e:
        log.exception("finishing the call failed")
        return f"unexpected: {type(e).__name__}"


async def after_call(loaded, record: dict) -> None:
    """The old direct path: used only when the retry queue cannot be reached. Best effort, once;
    the call is already recorded in the JSON file, and nothing here may raise."""
    try:
        record["summary"] = await summarize(transcript_lines(record["transcript"]))
        call_id = await save_call(loaded, record)
        if call_id is None:
            return
        log.info("call saved to the database")
        cfg = votel_config()
        if cfg is None:
            return
        result = await sync_call(
            cfg,
            loaded,
            record,
            call_id,
            source=source_for(record["room"]),
            app_url=os.getenv("APP_URL"),
        )
        if result.skipped:
            log.info("not sent to Votel: %s", result.skipped)
        else:
            await note_on_client(cfg, loaded, record, call_id)
            await mark_synced(call_id, contact_id=result.contact_id, error=result.error)
            log.info(
                "sent to Votel" if result.error is None else "Votel sync failed: %s", result.error
            )
    except Exception:
        log.exception("finishing the call failed")
