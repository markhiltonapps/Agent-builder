"""What happens after a call, one attempt at a time: safe to run again after any failure."""

from types import SimpleNamespace

import pytest

from agent_builder import call_finish
from agent_builder.call_finish import SUMMARY_TRIES, process_call
from agent_builder.votel_sync import SyncResult

LOADED = SimpleNamespace(account_id="22222222-2222-2222-2222-222222222222")

RECORD = {
    "room": "web-chat-abc",
    "started_at": 1000.0,
    "transcript": {
        "items": [
            {"type": "message", "role": "assistant", "content": ["Hi!"]},
            {"type": "message", "role": "user", "content": ["I need a cleaning"]},
        ]
    },
}


@pytest.fixture
def world(monkeypatch):
    """Stand-ins for the database, the summary model and Votel; the test sets what each does."""
    w = SimpleNamespace(
        saved=[],
        summary="Wants a cleaning.",
        votel=True,
        sync=SyncResult(contact_id="c1"),
        synced_before=False,
        account_ids=[],
        sent=[],
        marked=[],
        noted=[],
        save_ok=True,
    )

    async def save_call(loaded, record):
        w.saved.append(record.get("summary"))
        return "call1" if w.save_ok else None

    async def summarize(lines):
        return w.summary

    async def sync_call(cfg, loaded, record, call_id, **kw):
        w.sent.append(call_id)
        return w.sync

    async def call_synced(call_id):
        return w.synced_before

    async def mark_synced(call_id, *, contact_id, error):
        w.marked.append((contact_id, error))

    async def note(cfg, loaded, record, call_id):
        w.noted.append(call_id)

    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setattr(call_finish, "save_call", save_call)
    monkeypatch.setattr(call_finish, "summarize", summarize)
    monkeypatch.setattr(call_finish, "sync_call", sync_call)
    monkeypatch.setattr(call_finish, "call_synced", call_synced)
    monkeypatch.setattr(call_finish, "mark_synced", mark_synced)
    monkeypatch.setattr(call_finish, "note_on_client", note)
    monkeypatch.setattr(call_finish, "votel_config", lambda: object() if w.votel else None)

    async def votel_for(account_id):
        w.account_ids.append(account_id)
        return object() if w.votel else None

    monkeypatch.setattr(call_finish, "votel_config_for", votel_for)
    return w


def record():
    return {**RECORD}


async def test_a_good_call_is_saved_then_summarized_then_sent_once(world):
    assert await process_call(LOADED, record()) is None
    assert world.saved == [None, "Wants a cleaning."]  # on the list at once, summary added after
    assert world.sent == ["call1"] and world.noted == ["call1"] and world.marked == [("c1", None)]


async def test_a_call_that_cannot_be_saved_is_tried_again(world):
    world.save_ok = False
    assert await process_call(LOADED, record()) == "the call could not be saved"
    assert world.sent == []


async def test_votel_down_is_recorded_on_the_call_and_tried_again(world):
    world.sync = SyncResult(error="Votel said 502")
    assert await process_call(LOADED, record()) == "Votel: Votel said 502"
    assert world.marked == [(None, "Votel said 502")] and world.noted == []


async def test_a_retry_does_not_send_a_call_to_votel_twice(world):
    world.synced_before = True
    assert await process_call(LOADED, record(), attempt=1) is None
    assert world.sent == []


async def test_a_missing_summary_is_tried_again_a_few_times_then_the_call_goes_on_without(world):
    world.summary = None
    assert await process_call(LOADED, record(), attempt=0) == "no summary yet"
    assert world.sent == []  # the CRM note waits for the summary
    assert await process_call(LOADED, record(), attempt=SUMMARY_TRIES - 1) is None
    assert world.sent == ["call1"]


async def test_no_summary_is_expected_when_nobody_spoke_or_there_is_no_key(world, monkeypatch):
    world.summary = None
    silent = {**RECORD, "transcript": {"items": [RECORD["transcript"]["items"][0]]}}
    assert await process_call(LOADED, silent) is None
    monkeypatch.delenv("OPENAI_API_KEY")
    assert await process_call(LOADED, record()) is None


async def test_without_a_votel_connection_the_call_is_just_saved(world):
    world.votel = False
    assert await process_call(LOADED, record()) is None
    assert world.sent == []


async def test_a_call_votel_skips_is_finished(world):
    world.sync = SyncResult(skipped="a test call")
    assert await process_call(LOADED, record()) is None
    assert world.marked == []


async def test_nothing_ever_raises(world, monkeypatch):
    async def boom(*_a, **_k):
        raise ValueError("bug")

    monkeypatch.setattr(call_finish, "save_call", boom)
    assert await process_call(LOADED, record()) == "unexpected: ValueError"


async def test_the_clients_own_votel_account_is_used_for_its_call(world):
    await process_call(LOADED, record())
    assert world.account_ids == [LOADED.account_id]
