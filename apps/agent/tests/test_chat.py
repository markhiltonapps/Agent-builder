"""Website chat: the same agent as on the phone, typed. Against a stand-in text model."""

import asyncio
import json

import pytest
from aiohttp import web

from agent_builder import chat as chat_module
from agent_builder.calls_store import call_row, channel_for, source_for, transcript_lines
from agent_builder.chat import ChatError, ChatService
from agent_builder.config import AgentConfig
from agent_builder.loader import LoadedConfig
from agent_builder.template_library import all_industries, build

AGENT = "9bef4c7c-5c02-46fa-b325-f491a06c9d0c"
ACCOUNT = "22222222-2222-2222-2222-222222222222"


def _loaded() -> LoadedConfig:
    cfg = AgentConfig.model_validate(build(all_industries()[0]))
    return LoadedConfig(
        config=cfg,
        source="published",
        agent_id=AGENT,
        account_id=ACCOUNT,
        version_id="v",
        version=2,
    )


class FakeModel:
    """Answers Responses API calls from a script and records what it was asked."""

    def __init__(self):
        self.script: list = []
        self.requests: list[dict] = []
        self.url = ""

    async def handle(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.requests.append(body)
        step = self.script.pop(0) if self.script else {"content": "Okay."}
        if isinstance(step, int):
            return web.Response(status=step, text="no")
        output = []
        if step.get("content") is not None:
            output.append(
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": step["content"]}],
                }
            )
        output += step.get("calls", [])
        return web.json_response({"id": f"resp_{len(self.requests)}", "output": output})


@pytest.fixture
async def model():
    fake = FakeModel()
    app = web.Application()
    app.router.add_post("/v1/responses", fake.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    fake.url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/v1"
    yield fake
    await runner.cleanup()


class Harness:
    def __init__(self, model: FakeModel, **kw):
        self.begun: list[tuple[str, str]] = []
        self.verdict = "ok"
        self.finished: list[tuple[LoadedConfig, dict]] = []

        async def begin(agent_id: str, kind: str) -> str:
            self.begun.append((agent_id, kind))
            return self.verdict

        async def load(agent_id: str) -> LoadedConfig:
            return _loaded()

        async def finish(loaded: LoadedConfig, record: dict) -> None:
            self.finished.append((loaded, record))

        self.service = ChatService(
            begin=begin, load=load, finish=finish, key="k", base_url=model.url, **kw
        )


@pytest.fixture
def harness(model):
    return Harness(model)


def tool_call(name: str, args: dict | str, call_id: str = "call_1") -> dict:
    return {
        "calls": [
            {
                "type": "function_call",
                "call_id": call_id,
                "name": name,
                "arguments": args if isinstance(args, str) else json.dumps(args),
            }
        ]
    }


MESSAGE = {
    "first_name": "Sam",
    "last_name": "Lee",
    "phone": "5125550100",
    "reason": "A cleaning next week",
    "request_type": "appointment",
}


async def test_a_chat_opens_with_the_agents_greeting_and_counts_against_the_cap(harness):
    sid, greeting = await harness.service.start(AGENT)
    assert greeting and "{" not in greeting
    assert harness.begun == [(AGENT, "chat")]
    assert sid in harness.service.sessions


@pytest.mark.parametrize("verdict", ["disabled", "unpublished", "limit"])
async def test_a_chat_that_may_not_start_says_why(harness, verdict):
    harness.verdict = verdict
    with pytest.raises(ChatError) as e:
        await harness.service.start(AGENT)
    assert e.value.code == verdict
    assert harness.service.sessions == {}


async def test_the_model_gets_the_agents_own_instructions_tools_and_the_greeting(harness, model):
    model.script = [{"content": "Hi! How can I help?"}, {"content": "Yes we do."}]
    sid, greeting = await harness.service.start(AGENT)
    reply = await harness.service.send(sid, "  Do you take   new patients?  ")
    assert reply == "Hi! How can I help?"
    req = model.requests[0]
    assert "# This is a text chat" in req["instructions"] and "# Guardrails" in req["instructions"]
    assert req["input"] == [
        {"role": "assistant", "content": greeting},
        {"role": "user", "content": "Do you take new patients?"},
    ]
    assert "previous_response_id" not in req
    tools = {t["name"]: t for t in req["tools"]}
    assert {"take_message", "transfer_to_human"} <= set(tools)
    assert (
        tools["take_message"]["type"] == "function"
        and "properties" in tools["take_message"]["parameters"]
    )
    assert req["reasoning"] == {"effort": "low"} and req["model"] == "gpt-6-luna"
    # the next turn sends only what is new, and continues from the last response
    await harness.service.send(sid, "Great, thanks")
    assert model.requests[1]["input"] == [{"role": "user", "content": "Great, thanks"}]
    assert model.requests[1]["previous_response_id"] == "resp_1"
    assert model.requests[1]["instructions"] == req["instructions"]


async def test_a_tool_the_model_calls_really_runs_and_its_result_is_given_back(harness, model):
    model.script = [
        tool_call("take_message", MESSAGE),
        {"content": "Got it, the team will call you."},
    ]
    sid, _ = await harness.service.start(AGENT)
    reply = await harness.service.send(sid, "Book me a cleaning, Sam Lee, 512 555 0100")
    assert reply == "Got it, the team will call you."
    followup = model.requests[1]
    assert followup["previous_response_id"] == "resp_1"
    (result,) = followup["input"]
    assert result["type"] == "function_call_output" and result["call_id"] == "call_1"
    assert "recorded" in result["output"]
    session = harness.service.sessions[sid]
    assert [c.tool for c in session.recorder.calls] == [
        "take_message"
    ] and session.recorder.goal_reached is False


async def test_a_wrong_tool_or_bad_arguments_never_end_the_chat(harness, model):
    model.script = [
        tool_call("rm_rf", {}),
        tool_call("take_message", "{not json"),
        tool_call("take_message", "[1, 2]"),
        {"content": "Sorry, let me try that differently."},
    ]
    sid, _ = await harness.service.start(AGENT)
    assert await harness.service.send(sid, "hi") == "Sorry, let me try that differently."
    results = [r["input"][0]["output"] for r in model.requests[1:]]
    assert results == [
        "Error: no such tool.",
        "Error: the arguments were not valid.",
        "Error: the arguments were not valid.",
    ]


async def test_a_model_that_only_keeps_calling_tools_is_stopped(harness, model):
    model.script = [tool_call("take_message", MESSAGE, f"c{i}") for i in range(10)]
    sid, _ = await harness.service.start(AGENT)
    assert await harness.service.send(sid, "hi") == chat_module.SORRY
    assert len(model.requests) == chat_module.MAX_TOOL_ROUNDS + 1


async def test_messages_must_be_real_and_sessions_must_exist(harness):
    sid, _ = await harness.service.start(AGENT)
    with pytest.raises(ChatError) as e:
        await harness.service.send(sid, "   ")
    assert e.value.code == "empty"
    with pytest.raises(ChatError) as e:
        await harness.service.send(sid, "x" * (chat_module.MAX_USER_CHARS + 1))
    assert e.value.code == "too_long"
    with pytest.raises(ChatError) as e:
        await harness.service.send("nope", "hi")
    assert e.value.code == "gone"


async def test_a_long_chat_is_capped(harness, model, monkeypatch):
    monkeypatch.setattr(chat_module, "MAX_USER_TURNS", 2)
    sid, _ = await harness.service.start(AGENT)
    await harness.service.send(sid, "one")
    await harness.service.send(sid, "two")
    with pytest.raises(ChatError) as e:
        await harness.service.send(sid, "three")
    assert e.value.code == "limit"
    assert len(model.requests) == 2  # the third never reached the model


async def test_a_model_failure_is_retryable_and_leaves_no_trace(harness, model):
    model.script = [500, {"content": "Here now."}]
    sid, _ = await harness.service.start(AGENT)
    with pytest.raises(ChatError) as e:
        await harness.service.send(sid, "hello?")
    assert e.value.code == "try_again"
    assert await harness.service.send(sid, "hello?") == "Here now."
    # the failed attempt left no trace: the retry starts the conversation again from the greeting
    assert "previous_response_id" not in model.requests[1]
    assert [i["role"] for i in model.requests[1]["input"]] == ["assistant", "user"]


async def test_a_model_that_refuses_the_reasoning_setting_is_asked_again_without_it(harness, model):
    model.script = [400, {"content": "Fine."}]
    sid, _ = await harness.service.start(AGENT)
    assert await harness.service.send(sid, "hi") == "Fine."
    assert "reasoning" in model.requests[0] and "reasoning" not in model.requests[1]
    await harness.service.send(sid, "again")
    assert "reasoning" not in model.requests[2]


async def test_ending_a_chat_saves_it_once_as_a_web_chat(harness, model):
    model.script = [tool_call("take_message", MESSAGE), {"content": "Done, thanks Sam!"}]
    sid, greeting = await harness.service.start(AGENT)
    await harness.service.send(sid, "Book me a cleaning")
    assert await harness.service.end(sid) is True
    assert await harness.service.end(sid) is False
    assert harness.service.sessions == {}
    ((loaded, record),) = harness.finished
    assert loaded.agent_id == AGENT
    assert record["room"] == f"web-chat-{sid}"
    assert [c["tool"] for c in record["tool_calls"]] == ["take_message"]
    assert transcript_lines(record["transcript"]) == [
        {"who": "agent", "text": greeting},
        {"who": "caller", "text": "Book me a cleaning"},
        {"who": "agent", "text": "Done, thanks Sam!"},
    ]
    assert source_for(record["room"]) == "web" and channel_for(record["room"]) == "chat"
    row = call_row(loaded, record, source=source_for(record["room"]))
    assert row["source"] == "web" and row["channel"] == "chat" and row["account_id"] == ACCOUNT


async def test_a_chat_nobody_used_is_not_saved(harness):
    sid, _ = await harness.service.start(AGENT)
    assert await harness.service.end(sid) is True
    assert harness.finished == []


async def test_a_chat_that_goes_quiet_finishes_by_itself(model):
    h = Harness(model, idle_seconds=0.05)
    sid, _ = await h.service.start(AGENT)
    await h.service.send(sid, "hello")
    await asyncio.sleep(0.3)
    assert len(h.finished) == 1 and sid not in h.service.sessions
    with pytest.raises(ChatError) as e:
        await h.service.send(sid, "still there?")
    assert e.value.code == "gone"


async def test_a_failing_finish_never_breaks_ending(model):
    h = Harness(model)

    async def broken(loaded, record):
        raise RuntimeError("boom")

    h.service._finish = broken
    sid, _ = await h.service.start(AGENT)
    await h.service.send(sid, "hi")
    assert await h.service.end(sid) is True


async def test_too_many_open_chats_is_busy(harness, monkeypatch):
    monkeypatch.setattr(chat_module, "MAX_SESSIONS", 1)
    await harness.service.start(AGENT)
    with pytest.raises(ChatError) as e:
        await harness.service.start(AGENT)
    assert e.value.code == "busy"


async def test_stopping_the_server_finishes_open_chats(harness):
    sid, _ = await harness.service.start(AGENT)
    await harness.service.send(sid, "hi")
    await harness.service.close()
    assert len(harness.finished) == 1
