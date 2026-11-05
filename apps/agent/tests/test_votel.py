"""Votel over MCP: a fake Votel server speaks the same protocol, so the real client code runs."""

import asyncio
import socket

import pytest
import uvicorn
from livekit.agents import ChatContext
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from agent_builder.loader import DEFAULT_CONFIG, LoadedConfig, load_file
from agent_builder.votel import (
    VotelConfig,
    VotelError,
    call_tool,
    first_id,
    list_tool_names,
    votel_config,
)
from agent_builder.votel_sync import normalize_phone, note_text, sync_call

CONTACT_ID = "7c1f2b90-1111-4222-8333-444455556666"
TASK_ID = "1fa10000-aaaa-4bbb-8ccc-ddddeeeeffff"


class FakeVotel:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.auth: list[str] = []
        self.fail: set[str] = set()
        self.url = ""


def _build(fake: FakeVotel) -> FastMCP:
    mcp = FastMCP(
        "fake-votel",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    def run(name: str, args: dict, reply: str) -> str:
        fake.calls.append((name, args))
        return "Error: simulated failure" if name in fake.fail else reply

    @mcp.tool()
    def create_contact(
        phone: str = "",
        first_name: str = "",
        last_name: str = "",
        email: str = "",
        tags: list[str] | None = None,
    ) -> str:
        return run(
            "create_contact",
            {
                "phone": phone,
                "first_name": first_name,
                "last_name": last_name,
                **({"email": email} if email else {}),
                "tags": tags,
            },
            f"Batch create_contact: 1 created\n [0] created | {first_name} | id: {CONTACT_ID}",
        )

    @mcp.tool()
    def add_note(contact_id: str, note: str, subject: str = "") -> str:
        return run(
            "add_note", {"contact_id": contact_id, "note": note, "subject": subject}, "Note added."
        )

    @mcp.tool()
    def create_task(
        title: str, description: str = "", lead_id: str = "", priority: str = "medium"
    ) -> str:
        return run(
            "create_task",
            {"title": title, "description": description, "lead_id": lead_id, "priority": priority},
            f'Task "{title}" created!\n  ID: {TASK_ID}',
        )

    return mcp


@pytest.fixture
async def votel():
    fake = FakeVotel()
    app = _build(fake).streamable_http_app()

    async def capture(scope, receive, send):
        if scope["type"] == "http":
            fake.auth += [v.decode() for k, v in scope["headers"] if k == b"authorization"]
        await app(scope, receive, send)

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(capture, host="127.0.0.1", port=port, log_level="error", lifespan="on")
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    fake.url = f"http://127.0.0.1:{port}"
    yield fake
    server.should_exit = True
    await task


def _cfg(fake):
    return VotelConfig(key="sk_testkey", api_url=fake.url)


def _loaded():
    return LoadedConfig(
        config=load_file(DEFAULT_CONFIG),
        source="published",
        agent_id="a",
        account_id="b",
        version_id="v",
        version=3,
    )


def _record(**kw):
    chat = ChatContext.empty()
    base = {
        "room": "call-1",
        "started_at": 1793815344.0,
        "duration_s": 95.0,
        "goal_reached": False,
        "transferred": False,
        "transfer_reason": None,
        "caller_number": "(512) 555-0100",
        "tool_calls": [],
        "summary": "Caller asked about a leaking faucet.",
        "transcript": chat.to_dict(),
    }
    return {**base, **kw}


MESSAGE = {
    "tool": "take_message",
    "ok": True,
    "args": {"name": "Sam Lee", "phone": "5125550199", "reason": "Leaking faucet"},
}


# --- the client ----------------------------------------------------------------------------


async def test_the_key_goes_as_a_bearer_token_and_tools_are_listed(votel):
    names = await list_tool_names(_cfg(votel))
    assert {"create_contact", "add_note", "create_task"} <= set(names)
    assert votel.auth and all(a == "Bearer sk_testkey" for a in votel.auth)


async def test_call_tool_returns_text_and_ids_can_be_read_from_it(votel):
    text = await call_tool(_cfg(votel), "create_contact", {"phone": "+15125550100"})
    assert first_id(text) == CONTACT_ID


async def test_a_votel_error_reply_raises(votel):
    votel.fail.add("add_note")
    with pytest.raises(VotelError, match="simulated failure"):
        await call_tool(_cfg(votel), "add_note", {"contact_id": CONTACT_ID, "note": "x"})


async def test_an_unreachable_votel_raises_a_votel_error_not_a_crash():
    with pytest.raises(VotelError):
        await call_tool(
            VotelConfig(key="k", api_url="http://127.0.0.1:1"), "create_contact", {}, timeout_s=3
        )


def test_config_comes_from_the_environment(monkeypatch):
    monkeypatch.delenv("VOTEL_API_KEY", raising=False)
    assert votel_config() is None
    monkeypatch.setenv("VOTEL_API_KEY", "  sk_abc \n")
    monkeypatch.setenv("VOTEL_API_URL", "https://example.test/")
    cfg = votel_config()
    assert cfg.key == "sk_abc" and cfg.mcp_url == "https://example.test/mcp"


# --- the post-call sync ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("(512) 555-0100", "+15125550100"),
        ("512-555-0100", "+15125550100"),
        ("1 512 555 0100", "+15125550100"),
        ("+44 20 7946 0958", "+442079460958"),
        ("12345", None),
        (None, None),
        ("", None),
    ],
)
def test_phone_numbers_are_normalized_or_rejected(raw, want):
    assert normalize_phone(raw) == want


async def test_a_phone_call_with_a_message_makes_a_contact_a_note_and_a_task(votel):
    rec = _record(tool_calls=[MESSAGE])
    res = await sync_call(
        _cfg(votel), _loaded(), rec, "call-uuid", source="phone", app_url="https://app.test"
    )
    assert (res.contact_id, res.error) == (CONTACT_ID, None)
    names = [n for n, _ in votel.calls]
    assert names == ["create_contact", "add_note", "create_task"]
    contact, note, task = (a for _, a in votel.calls)
    assert contact["phone"] == "+15125550100" and contact["tags"] == ["voice-agent"]
    assert contact["first_name"] == "Sam" and contact["last_name"] == "Lee"
    assert note["contact_id"] == CONTACT_ID
    assert (
        "https://app.test/calls/call-uuid" in note["note"]
        and "Caller asked about a leaking faucet." in note["note"]
    )
    assert "Message left" in note["note"] and "Leaking faucet" in note["note"]
    assert (
        task["lead_id"] == CONTACT_ID
        and task["priority"] == "medium"
        and task["title"].startswith("Call back Sam Lee")
    )


async def test_a_transfer_is_a_high_priority_task(votel):
    rec = _record(transferred=True, transfer_reason="Caller smells gas")
    await sync_call(_cfg(votel), _loaded(), rec, "c", source="phone")
    task = votel.calls[-1][1]
    assert (
        task["priority"] == "high"
        and task["title"].startswith("Take over")
        and "smells gas" in task["title"]
    )


async def test_a_plain_call_gets_a_note_and_no_task(votel):
    await sync_call(_cfg(votel), _loaded(), _record(), "c", source="phone")
    assert [n for n, _ in votel.calls] == ["create_contact", "add_note"]


async def test_browser_test_calls_never_touch_the_crm(votel, monkeypatch):
    monkeypatch.delenv("VOTEL_SYNC_TEST_CALLS", raising=False)
    res = await sync_call(
        _cfg(votel), _loaded(), _record(tool_calls=[MESSAGE]), "c", source="browser"
    )
    assert res.skipped == "test call" and votel.calls == []
    monkeypatch.setenv("VOTEL_SYNC_TEST_CALLS", "1")
    assert (
        await sync_call(
            _cfg(votel), _loaded(), _record(tool_calls=[MESSAGE]), "c", source="browser"
        )
    ).contact_id


async def test_no_identifiable_caller_means_nothing_is_sent(votel):
    res = await sync_call(_cfg(votel), _loaded(), _record(caller_number=None), "c", source="phone")
    assert res.skipped == "no caller number" and votel.calls == []


async def test_the_phone_from_a_message_is_used_when_the_line_gave_none(votel):
    await sync_call(
        _cfg(votel),
        _loaded(),
        _record(caller_number=None, tool_calls=[MESSAGE]),
        "c",
        source="phone",
    )
    assert votel.calls[0][1]["phone"] == "+15125550199"


async def test_a_votel_failure_is_reported_not_raised_and_keeps_the_contact(votel):
    votel.fail.add("create_task")
    res = await sync_call(
        _cfg(votel), _loaded(), _record(tool_calls=[MESSAGE]), "c", source="phone"
    )
    assert res.contact_id == CONTACT_ID and "simulated failure" in res.error


def test_the_note_reads_like_a_person_wrote_it():
    text = note_text(_loaded(), _record(goal_reached=True), "id1", "https://app.test/")
    assert "version 3" in text and "1:35 long" in text and "completed its goal" in text
    assert text.rstrip().endswith("https://app.test/calls/id1")


async def test_a_full_message_sets_the_name_email_and_task_type(votel):
    msg = {
        "tool": "take_message",
        "ok": True,
        "args": {
            "first_name": "Ana",
            "last_name": "Ruiz",
            "phone": "5125550142",
            "email": "ana@example.com",
            "reason": "Wants a cleaning next week",
            "request_type": "appointment",
        },
    }
    await sync_call(_cfg(votel), _loaded(), _record(tool_calls=[msg]), "c", source="phone")
    contact = next(a for n, a in votel.calls if n == "create_contact")
    task = next(a for n, a in votel.calls if n == "create_task")
    assert contact["first_name"] == "Ana" and contact["last_name"] == "Ruiz"
    assert contact["email"] == "ana@example.com"
    assert task["title"].startswith("Book appointment for Ana Ruiz")


async def test_a_badly_typed_email_never_blocks_the_contact(votel):
    msg = {
        "tool": "take_message",
        "ok": True,
        "args": {
            "first_name": "Ana",
            "last_name": "Ruiz",
            "phone": "5125550142",
            "email": "ana at example dot com",
            "reason": "Call me",
        },
    }
    await sync_call(_cfg(votel), _loaded(), _record(tool_calls=[msg]), "c", source="phone")
    contact = next(a for n, a in votel.calls if n == "create_contact")
    assert "email" not in contact
    assert "ana at example dot com" in next(a for n, a in votel.calls if n == "add_note")["note"]


async def test_an_urgent_request_is_a_high_priority_task(votel):
    msg = {
        "tool": "take_message",
        "ok": True,
        "args": {
            "first_name": "Bo",
            "last_name": "Kim",
            "phone": "5125550143",
            "reason": "Pipe burst",
            "request_type": "urgent",
        },
    }
    await sync_call(_cfg(votel), _loaded(), _record(tool_calls=[msg]), "c", source="phone")
    task = next(a for n, a in votel.calls if n == "create_task")
    assert task["priority"] == "high" and task["title"].startswith("URGENT: call back Bo Kim")
