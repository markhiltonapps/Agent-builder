"""The demo failure: a dropped session came back with no memory and greeted again.

These tests pin the fix: the conversation is saved per room, restored into the next session,
the greeting is replaced by a resume note, completed work is not redone, and a restored
conversation actually reaches GPT-Live when the new session starts.
"""

import asyncio
import json
import time

import pytest
from livekit.agents import ChatContext

from agent_builder.adapters.mock import MockAdapter
from agent_builder.compiler import compile_agent
from agent_builder.loader import DEFAULT_CONFIG, load_file
from agent_builder.session_store import FileStore, MemoryStore, SavedCall, Saver
from agent_builder.tools import CallRecorder, build_tools
from agent_builder.worker import resume_from, resume_instructions

BOOKING = {
    "name": "Sam Lee",
    "phone": "5125550100",
    "address": "1 Main St",
    "zip_code": "78704",
    "service_type": "plumbing",
    "date": "2026-11-05",
    "window": "8am to 11am",
    "problem": "leaking faucet",
}


@pytest.fixture
def cfg():
    return load_file(DEFAULT_CONFIG)


def _conversation() -> ChatContext:
    ctx = ChatContext.empty()
    ctx.add_message(role="assistant", content="Thanks for calling Brightline Home Services.")
    ctx.add_message(role="user", content="My kitchen faucet is leaking. I'm in 78704.")
    ctx.add_message(role="assistant", content="We serve 78704. What day works for you?")
    return ctx


async def _booked_call(cfg):
    """A call that has booked a visit, as the worker would hold it."""
    recorder = CallRecorder()
    tools, adapters = build_tools(cfg, compile_agent(cfg), recorder)
    schedule = next(t for t in tools if t.info.name == "schedule_visit")
    await schedule(raw_arguments=dict(BOOKING), context=None)
    return recorder, adapters


# --- stores -------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["memory", "file"])
async def test_store_roundtrip_and_end(kind, tmp_path):
    store = MemoryStore() if kind == "memory" else FileStore(tmp_path)
    call = SavedCall(room="room-1", chat=_conversation().to_dict(), started_at=1.0)
    await store.save(call)
    loaded = await store.load("room-1")
    assert loaded is not None and loaded.chat == call.chat and not loaded.ended
    await store.end("room-1")
    assert (await store.load("room-1")).ended
    assert await store.load("other-room") is None


async def test_file_store_sanitizes_room_names(tmp_path):
    store = FileStore(tmp_path)
    await store.save(SavedCall(room="../../etc/passwd", chat={"items": []}))
    assert [p.parent for p in tmp_path.iterdir()] == [tmp_path]


async def test_saver_coalesces_and_keeps_latest():
    store = MemoryStore()
    counter = {"n": 0}

    def snap():
        counter["n"] += 1
        return SavedCall(room="r", chat={"items": []}, recoveries=counter["n"])

    saver = Saver(store, snap)
    for _ in range(5):
        saver.mark()
    await saver.flush()
    assert counter["n"] <= 3  # five marks, at most a couple of writes
    saved = await store.load("r")
    assert saved.recoveries == counter["n"]  # the latest snapshot landed


async def test_saver_survives_store_failure():
    class Broken(MemoryStore):
        async def save(self, call):
            raise RuntimeError("db down")

    saver = Saver(Broken(), lambda: SavedCall(room="r", chat={"items": []}))
    saver.mark()
    await asyncio.sleep(0)
    await asyncio.sleep(0)  # the failed write is logged, not raised into the call


# --- conversation survives serialization ---------------------------------------------------


def test_chat_context_roundtrip_keeps_turns_and_tools():
    ctx = _conversation()
    from livekit.agents.llm import FunctionCall, FunctionCallOutput

    ctx.items.append(
        FunctionCall(call_id="c1", name="check_service_area", arguments='{"zip_code": "78704"}')
    )
    ctx.items.append(
        FunctionCallOutput(
            call_id="c1", name="check_service_area", output='{"found": true}', is_error=False
        )
    )
    restored = ChatContext.from_dict(json.loads(json.dumps(ctx.to_dict())))
    assert [i.type for i in restored.items] == [i.type for i in ctx.items]
    assert restored.items[1].text_content == "My kitchen faucet is leaking. I'm in 78704."


# --- resume decision -----------------------------------------------------------------------


async def test_new_call_does_not_resume(cfg):
    recorder = CallRecorder()
    _, adapters = build_tools(cfg, compile_agent(cfg), recorder)
    assert resume_from(None, recorder, adapters, max_age_s=900) is None


async def test_ended_or_stale_call_does_not_resume(cfg):
    recorder = CallRecorder()
    _, adapters = build_tools(cfg, compile_agent(cfg), recorder)
    now = time.time()
    ended = SavedCall(room="r", chat={"items": []}, updated_at=now, ended=True)
    stale = SavedCall(room="r", chat={"items": []}, updated_at=now - 3600)
    assert resume_from(ended, recorder, adapters, max_age_s=900, now=now) is None
    assert resume_from(stale, recorder, adapters, max_age_s=900, now=now) is None


async def test_live_call_resumes_with_memory_and_no_greeting(cfg):
    recorder, adapters = await _booked_call(cfg)
    now = time.time()
    saved = SavedCall(
        room="r",
        chat=_conversation().to_dict(),
        tool_calls=recorder.to_json(),
        adapter_state={n: a.snapshot() for n, a in adapters.items()},
        started_at=now - 60,
        updated_at=now - 2,
        recoveries=0,
    )

    fresh_recorder = CallRecorder()
    _, fresh_adapters = build_tools(cfg, compile_agent(cfg), fresh_recorder)
    resumed = resume_from(saved, fresh_recorder, fresh_adapters, max_age_s=900, now=now)
    assert resumed is not None
    chat, started, recoveries, note = resumed

    assert len(chat.items) == 3  # the conversation came back
    assert started == now - 60 and recoveries == 1
    assert "Do not greet" in note
    assert "schedule_visit(" in note and "-> BL-1001" in note  # completed work is restated
    assert fresh_recorder.goal_reached  # and still counts toward the call outcome


async def test_rebooking_after_resume_is_not_a_duplicate(cfg):
    _, adapters = await _booked_call(cfg)
    snap = adapters["demo_data"].snapshot()

    fresh = MockAdapter("demo_data", cfg.adapters["demo_data"].options)
    fresh.restore(snap)
    again = await fresh.call("schedule_visit", dict(BOOKING))
    assert again["duplicate"] is True and again["id"] == "BL-1001"
    assert len(fresh.state["bookings"]) == 1
    other = await fresh.call("schedule_visit", {**BOOKING, "date": "2026-11-06"})
    assert other["id"] == "BL-1002"


def test_resume_note_without_completed_work():
    note = resume_instructions("")
    assert "Already done" not in note and "Do not greet" in note


def test_opening_line_is_said_once(cfg):
    assert "Say this only once" in compile_agent(cfg).voice_instructions


# --- the restored conversation reaches GPT-Live --------------------------------------------


async def test_restored_conversation_is_sent_to_gpt_live(cfg, monkeypatch):
    """A fresh GPT-Live session seeded with the saved conversation sends it at session start.

    This is the path every recovery takes: new session, old conversation, no greeting.
    No network: the session's connection task is cancelled before it can connect.
    """
    from livekit.agents.llm import DuplexRealtimeAdapter

    from agent_builder.providers import build_voice_model

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    compiled = compile_agent(cfg)
    adapter = DuplexRealtimeAdapter(build_voice_model(cfg.runtime.voice, compiled))
    rt = adapter.session()
    try:
        await rt._update_session(
            instructions=compiled.voice_instructions, chat_ctx=_conversation(), tools=[]
        )
        start = rt._duplex._session_start_event()
        sent = [p.text for item in start.session.input for p in item.content]
        assert "My kitchen faucet is leaking. I'm in 78704." in sent
        assert start.session.instructions == compiled.voice_instructions
    finally:
        await rt.aclose()
        await adapter.duplex_model.aclose()
