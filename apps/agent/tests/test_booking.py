"""The booking-link tool: text or email the caller a link through Votel, or fail honestly."""

import asyncio
import json
import socket

import pytest
import uvicorn
from livekit.agents import ToolError
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import ValidationError

from agent_builder.compiler import compile_agent
from agent_builder.config import AgentConfig
from agent_builder.loader import DEFAULT_CONFIG
from agent_builder.tools import CallRecorder, build_tools

RAW = json.loads(DEFAULT_CONFIG.read_text())
LINK = "https://book.example.com/book/free-estimate"


def _cfg(**booking):
    return AgentConfig.model_validate({**RAW, "booking": {"url": LINK, **booking}})


class Fake:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.fail: set[str] = set()


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
    def send_sms(to: str, body: str) -> str:
        fake.calls.append(("send_sms", {"to": to, "body": body}))
        return (
            "Error: no SMS sender is connected"
            if "send_sms" in fake.fail
            else "Scheduled. Send id: abc"
        )

    @mcp.tool()
    def send_email(to: str, subject: str = "", body: str = "") -> str:
        fake.calls.append(("send_email", {"to": to, "subject": subject, "body": body}))
        return "Scheduled."

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
    return next(t for t in tools if t.info.name == "send_booking_link"), rec


def test_the_link_must_be_https():
    with pytest.raises(ValidationError, match="https"):
        _cfg(url="http://insecure.example.com/book/x")
    with pytest.raises(ValidationError):
        _cfg(url="not a link at all")


def test_the_tool_exists_only_when_a_booking_link_is_configured():
    plain = AgentConfig.model_validate(RAW)
    names = {t.info.name for t in build_tools(plain, compile_agent(plain), CallRecorder())[0]}
    assert "send_booking_link" not in names
    assert "send_booking_link" in {
        t.info.name for t in build_tools(_cfg(), compile_agent(_cfg()), CallRecorder())[0]
    }


def test_the_prompt_tells_the_agent_it_can_send_a_link():
    assert "link by text" in compile_agent(_cfg()).voice_instructions
    assert "link by email" in compile_agent(_cfg(channel="email")).voice_instructions
    assert "link by" not in compile_agent(AgentConfig.model_validate(RAW)).voice_instructions


async def test_on_a_phone_call_the_known_number_gets_the_text(votel):
    tool, rec = _tool(_cfg(), caller=lambda: "(602) 555-0123")
    out = json.loads(await tool(raw_arguments={}, context=None))
    assert out["status"] == "sent" and out["sent_to"] == "+16025550123"
    ((name, args),) = votel.calls
    assert name == "send_sms" and args["to"] == "+16025550123" and LINK in args["body"]
    (call,) = rec.calls
    assert (call.tool, call.ok, call.goal) == ("send_booking_link", True, True)


async def test_without_a_known_number_the_agent_must_ask_for_one(votel):
    tool, rec = _tool(_cfg())
    with pytest.raises(ToolError, match="take_message"):
        await tool(raw_arguments={}, context=None)
    assert votel.calls == [] and rec.calls[0].ok is False
    out = json.loads(await tool(raw_arguments={"phone": "602-555-0188"}, context=None))
    assert out["sent_to"] == "+16025550188"


async def test_email_needs_a_real_address_and_sends_it(votel):
    tool, _ = _tool(_cfg(channel="email"))
    with pytest.raises(ToolError):
        await tool(raw_arguments={"email": "nope"}, context=None)
    out = json.loads(await tool(raw_arguments={"email": "sam@example.com"}, context=None))
    assert out["sent_to"] == "sam@example.com"
    assert votel.calls[-1][0] == "send_email" and LINK in votel.calls[-1][1]["body"]


async def test_when_votel_cannot_send_the_caller_is_not_promised_a_text(votel):
    votel.fail.add("send_sms")
    tool, rec = _tool(_cfg(), caller=lambda: "+16025550123")
    with pytest.raises(ToolError, match="take a message"):
        await tool(raw_arguments={}, context=None)
    assert rec.calls[-1].ok is False and rec.goal_reached is False


async def test_without_a_votel_key_it_fails_cleanly(monkeypatch):
    monkeypatch.delenv("VOTEL_API_KEY", raising=False)
    tool, rec = _tool(_cfg(), caller=lambda: "+16025550123")
    with pytest.raises(ToolError):
        await tool(raw_arguments={}, context=None)
    assert rec.calls[-1].ok is False
