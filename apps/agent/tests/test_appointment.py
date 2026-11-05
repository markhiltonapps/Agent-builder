"""request_appointment: put a pending appointment on the team's Votel calendar, or fail honestly."""

import asyncio
import json
import socket
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
import uvicorn
from livekit.agents import ToolError
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import ValidationError

from agent_builder.adapters import ToolFailed
from agent_builder.compiler import compile_agent
from agent_builder.config import AgentConfig
from agent_builder.loader import DEFAULT_CONFIG
from agent_builder.tools import CallRecorder, build_tools, parse_when
from agent_builder.votel_import import parse_bookables

RAW = json.loads(DEFAULT_CONFIG.read_text())
SERVICE = "96f7b504-80ee-4eda-9cb9-81bffe6c9059"
TZ = ZoneInfo(RAW["persona"]["timezone"])


def _cfg(**cal):
    base = {"service_id": SERVICE, "service_name": "Free Plumbing Estimate", "duration_minutes": 60}
    return AgentConfig.model_validate({**RAW, "calendar": {**base, **cal}})


def _soon(days=10, hour=14, minute=30):
    """A day and time safely in the future, in the agent's own time zone."""
    d = datetime.now(TZ) + timedelta(days=days)
    return d.strftime("%Y-%m-%d"), f"{hour:02d}:{minute:02d}", d.replace(hour=hour, minute=minute)


GOOD = {
    "first_name": "Ana",
    "last_name": "Ruiz",
    "reason": "Leaking kitchen faucet",
    "email": "ana@example.com",
}


class Fake:
    def __init__(self):
        self.bookings: list[dict] = []
        self.error: str | None = None


@pytest.fixture
async def votel(monkeypatch):
    fake = Fake()
    mcp = FastMCP(
        "fake",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    @mcp.tool()
    def create_booking(
        booking_config_id: str,
        starts_at: str,
        ends_at: str,
        duration_minutes: int,
        timezone: str = "",
        client_name: str = "",
        client_phone: str = "",
        client_email: str = "",
        client_notes: str = "",
        status: str = "confirmed",
        internal_notes: str = "",
    ) -> str:
        if fake.error:
            return f"Error: {fake.error}"
        fake.bookings.append(locals().copy())
        return "Booking created. ID: 11111111-2222-4333-8444-555555555555"

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(mcp.streamable_http_app(), host="127.0.0.1", port=port, log_level="error")
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    monkeypatch.setenv("VOTEL_API_KEY", "sk_test")
    monkeypatch.setenv("VOTEL_API_URL", f"http://127.0.0.1:{port}")
    yield fake
    server.should_exit = True
    await task


def _tool(cfg, caller=lambda: None):
    rec = CallRecorder()
    tools, _ = build_tools(cfg, compile_agent(cfg), rec, caller)
    return next(t for t in tools if t.info.name == "request_appointment"), rec


def test_the_calendar_is_validated():
    with pytest.raises(ValidationError):
        _cfg(service_id="not-an-id")
    with pytest.raises(ValidationError):
        _cfg(duration_minutes=2)
    with pytest.raises(ValidationError):
        _cfg(duration_minutes=9999)


def test_the_tool_exists_only_with_a_calendar_and_the_prompt_says_it_is_only_a_request():
    plain = AgentConfig.model_validate(RAW)
    assert "request_appointment" not in {
        t.info.name for t in build_tools(plain, compile_agent(plain), CallRecorder())[0]
    }
    prompt = compile_agent(_cfg()).voice_instructions
    assert 'Request an appointment for "Free Plumbing Estimate"' in prompt
    assert "Never say it is booked or confirmed" in prompt
    assert "Request an appointment" not in compile_agent(plain).voice_instructions


def test_the_name_is_reserved_so_a_custom_tool_cannot_shadow_it():
    raw = json.loads(json.dumps(RAW))
    raw["tools"][0]["name"] = "request_appointment"
    with pytest.raises(ValidationError, match="reserved"):
        AgentConfig.model_validate(raw)


async def test_a_good_request_goes_to_the_calendar_as_pending(votel):
    date, clock, _ = _soon()
    tool, rec = _tool(_cfg(), caller=lambda: "(602) 555-0123")
    out = json.loads(await tool(raw_arguments={**GOOD, "date": date, "time": clock}, context=None))
    assert out["status"] == "requested" and "The team will confirm it" in out["say"]
    assert "booked" not in out["say"].lower() or "not" in out["say"].lower()
    (b,) = votel.bookings
    assert b["booking_config_id"] == SERVICE and b["status"] == "pending"
    assert b["starts_at"] == f"{date}T14:30:00" and b["ends_at"] == f"{date}T15:30:00"
    assert b["timezone"] == RAW["persona"]["timezone"] and b["duration_minutes"] == 60
    assert b["client_name"] == "Ana Ruiz" and b["client_phone"] == "+16025550123"
    assert b["client_email"] == "ana@example.com" and "faucet" in b["client_notes"]
    assert "Not confirmed" in b["internal_notes"]
    (call,) = rec.calls
    assert (call.tool, call.ok, call.goal) == ("request_appointment", True, True)


async def test_the_callers_own_number_is_used_and_a_given_number_wins(votel):
    date, clock, _ = _soon()
    tool, _ = _tool(_cfg(), caller=lambda: "+16025550123")
    await tool(
        raw_arguments={**GOOD, "date": date, "time": clock, "phone": "480-555-0199"}, context=None
    )
    assert votel.bookings[-1]["client_phone"] == "+14805550199"


async def test_a_badly_typed_email_does_not_block_the_request(votel):
    date, clock, _ = _soon()
    tool, _ = _tool(_cfg(), caller=lambda: "+16025550123")
    await tool(
        raw_arguments={**GOOD, "email": "ana at example", "date": date, "time": clock}, context=None
    )
    assert "client_email" not in votel.bookings[-1] or not votel.bookings[-1]["client_email"]


@pytest.mark.parametrize(
    ("override", "expect"),
    [
        ({"date": "2020-01-01"}, "already passed"),
        ({"date": "next tuesday"}, "YYYY-MM-DD"),
        ({"time": "late afternoon"}, "clock time"),
        ({"first_name": ""}, "first and last name"),
    ],
)
async def test_bad_input_is_explained_and_nothing_is_sent(votel, override, expect):
    date, clock, _ = _soon()
    tool, rec = _tool(_cfg(), caller=lambda: "+16025550123")
    args = {**GOOD, "date": date, "time": clock, **override}
    with pytest.raises(ToolError, match=expect):
        await tool(raw_arguments=args, context=None)
    assert votel.bookings == [] and rec.calls[0].ok is False


async def test_without_any_phone_number_the_agent_must_ask(votel):
    date, clock, _ = _soon()
    tool, _ = _tool(_cfg())
    with pytest.raises(ToolError, match="phone number"):
        await tool(raw_arguments={**GOOD, "date": date, "time": clock}, context=None)
    assert votel.bookings == []


async def test_a_taken_time_tells_the_agent_to_offer_another(votel):
    date, clock, _ = _soon()
    votel.error = "That time conflicts with an existing booking"
    tool, rec = _tool(_cfg(), caller=lambda: "+16025550123")
    with pytest.raises(ToolError, match="different day or time"):
        await tool(raw_arguments={**GOOD, "date": date, "time": clock}, context=None)
    assert rec.calls[0].ok is False


async def test_any_other_votel_problem_falls_back_to_taking_a_message(votel):
    date, clock, _ = _soon()
    votel.error = "Internal server error"
    tool, _ = _tool(_cfg(), caller=lambda: "+16025550123")
    with pytest.raises(ToolError, match="take_message"):
        await tool(raw_arguments={**GOOD, "date": date, "time": clock}, context=None)


async def test_with_votel_not_connected_the_caller_is_not_promised_anything(monkeypatch):
    monkeypatch.delenv("VOTEL_API_KEY", raising=False)
    date, clock, _ = _soon()
    tool, rec = _tool(_cfg(), caller=lambda: "+16025550123")
    with pytest.raises(ToolError, match="take_message"):
        await tool(raw_arguments={**GOOD, "date": date, "time": clock}, context=None)
    assert rec.calls[0].ok is False


def test_clock_times_are_read_the_way_people_say_them():
    base = datetime(2026, 1, 1, 8, 0, tzinfo=TZ)
    tz = RAW["persona"]["timezone"]
    day = "2026-03-10"
    got = {
        t: parse_when(day, t, tz, base).strftime("%H:%M")
        for t in ["14:30", "2:30 pm", "2 PM", "12 am", "12:15 pm", "9"]
    }
    assert got == {
        "14:30": "14:30",
        "2:30 pm": "14:30",
        "2 PM": "14:00",
        "12 am": "00:00",
        "12:15 pm": "12:15",
        "9": "09:00",
    }
    with pytest.raises(ToolFailed, match="too far"):
        parse_when("2028-03-10", "10:00", tz, base)
    with pytest.raises(ToolFailed, match="already passed"):
        parse_when("2025-12-31", "10:00", tz, base)


def test_votels_booking_services_are_read_from_its_text():
    text = (
        "Found 3 bookable service(s):\n\n"
        "- Neato Ventures Discovery Call (for business owners) [LIVE] [meeting] 30min id: 68fc7813-adcb-4142-b44a-09a187f79f44\n"
        "- Free Plumbing Estimate [LIVE] [appointment] 60min id: 96f7b504-80ee-4eda-9cb9-81bffe6c9059\n"
        "- Old &amp; Retired Thing [DRAFT] [class] 90min id: A717AEA8-DEB2-46F3-B9E1-8089FCB92A4F\n\n"
        "If none of these match the service the user described, say so."
    )
    found = parse_bookables(text)
    assert [(b.name, b.status, b.kind, b.minutes) for b in found] == [
        ("Neato Ventures Discovery Call (for business owners)", "live", "meeting", 30),
        ("Free Plumbing Estimate", "live", "appointment", 60),
        ("Old & Retired Thing", "draft", "class", 90),
    ]
    assert found[2].id == "a717aea8-deb2-46f3-b9e1-8089fcb92a4f"
