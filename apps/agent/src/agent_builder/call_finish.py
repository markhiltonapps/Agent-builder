"""Everything that happens once a call or chat is over.

Shared by the voice worker and website chat: summarize it, save it to the database, send it to
Votel, and note it on the client's own Votel contact. Every step is best effort: nothing here
may raise into a call or a chat.
"""

from __future__ import annotations

import logging
import os

from .calls_store import account_contact, mark_synced, save_call, source_for, transcript_lines
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


async def after_call(loaded, record: dict) -> None:
    """Everything that happens once a call is over. Each step is best effort: the call is
    already recorded in the JSON file, and nothing here may raise."""
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
