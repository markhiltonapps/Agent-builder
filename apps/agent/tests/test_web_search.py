"""Web search for an agent: Google through Gemini, OpenAI as the backup, a cap per call, and what the agent is told."""

import pytest
from aiohttp import web
from livekit.agents import ToolError

from agent_builder.compiler import compile_agent
from agent_builder.config import AgentConfig, WebSearch
from agent_builder.loader import DEFAULT_CONFIG, load_file
from agent_builder.tools import CallRecorder, _web_search_tool, build_tools
from agent_builder.web_search import SearchError, WebAnswer, search_web


class Fake:
    """Stand-ins for Google's and OpenAI's search endpoints."""

    def __init__(self):
        self.gemini: dict[str, object] = {}  # model -> status int or response dict
        self.openai: object = {"output": []}
        self.seen: list[tuple[str, dict]] = []
        self.base = ""

    async def g(self, request: web.Request) -> web.Response:
        model = request.match_info["model"].split(":")[0]
        self.seen.append((model, await request.json()))
        out = self.gemini.get(model, 404)
        if isinstance(out, int):
            return web.Response(status=out, text="no")
        return web.json_response(out)

    async def o(self, request: web.Request) -> web.Response:
        self.seen.append(("openai", await request.json()))
        if isinstance(self.openai, int):
            return web.Response(status=self.openai, text="no")
        return web.json_response(self.openai)


@pytest.fixture
async def fake():
    f = Fake()
    app = web.Application()
    app.router.add_post("/g/models/{model}", f.g)
    app.router.add_post("/o/responses", f.o)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    f.base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    yield f
    await runner.cleanup()


def gemini_answer(text, titles=()):
    return {
        "candidates": [
            {
                "content": {"parts": [{"text": text}]},
                "groundingMetadata": {
                    "groundingChunks": [{"web": {"title": t, "uri": "https://x"}} for t in titles]
                },
            }
        ]
    }


async def ask(f: Fake, **kw):
    return await search_web(
        "golf courses near the hotel",
        "Houston, Texas",
        gemini_base=f.base + "/g",
        openai_base=f.base + "/o",
        **kw,
    )


async def test_google_answers_with_its_sources_and_is_told_the_place(fake):
    fake.gemini["gemini-3.1-flash-lite"] = gemini_answer(
        "**Memorial Park Golf Course** is a public 18-hole course, from about $40. See https://example.com",
        ["Memorial Park Golf", "Houston Parks", "Memorial Park Golf"],
    )
    a = await ask(fake, gemini_key="g")
    assert (
        a.text == "Memorial Park Golf Course is a public 18-hole course, from about $40. See"
        and a.sources == ["Memorial Park Golf", "Houston Parks"]
    )
    assert a.engine == "google:gemini-3.1-flash-lite"
    _, body = fake.seen[0]
    assert (
        body["tools"] == [{"google_search": {}}]
        and "Houston, Texas" in body["contents"][0]["parts"][0]["text"]
    )


async def test_a_model_that_is_not_available_is_skipped_for_the_next(fake):
    fake.gemini["gemini-3.5-flash-lite"] = gemini_answer("A short answer.")
    a = await ask(fake, gemini_key="g")
    assert a.engine == "google:gemini-3.5-flash-lite" and [m for m, _ in fake.seen] == [
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
    ]


async def test_openai_search_is_the_backup_when_google_cannot_answer(fake):
    fake.gemini["gemini-3.1-flash-lite"] = 500
    fake.openai = {
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": "Two courses nearby.",
                        "annotations": [{"title": "Course guide"}],
                    }
                ],
            }
        ]
    }
    a = await ask(fake, gemini_key="g", openai_key="o")
    assert (
        a.text == "Two courses nearby." and a.sources == ["Course guide"] and a.engine == "openai"
    )
    assert any(m == "openai" and b["tools"] == [{"type": "web_search"}] for m, b in fake.seen)


async def test_nothing_answering_says_so_and_no_keys_is_a_clear_error(fake):
    fake.gemini["gemini-3.1-flash-lite"] = 500
    fake.openai = 500
    with pytest.raises(SearchError):
        await ask(fake, gemini_key="g", openai_key="o")
    with pytest.raises(SearchError, match="no search key"):
        await ask(fake, gemini_key="", openai_key="")


async def test_the_tool_reads_back_the_answer_records_it_and_stops_at_the_cap():
    calls = []

    async def searcher(query, location):
        calls.append((query, location))
        return WebAnswer("Dunes Golf Links has 18 holes.", ["Dunes Golf Links"], "google:test")

    rec = CallRecorder()
    tool = _web_search_tool(
        WebSearch(enabled=True, location="Houston, Texas", max_per_call=2), rec, searcher
    )
    out = await tool({"query": "  golf   near the hotel "}, None)
    assert (
        "Dunes Golf Links has 18 holes." in out
        and "Sources: Dunes Golf Links." in out
        and "can change" in out
    )
    assert calls == [("golf near the hotel", "Houston, Texas")]
    await tool({"query": "restaurants"}, None)
    with pytest.raises(ToolError, match="as many times"):
        await tool({"query": "a third"}, None)
    with pytest.raises(ToolError):
        await _web_search_tool(WebSearch(enabled=True), CallRecorder(), searcher)(
            {"query": "  "}, None
        )
    assert [(c.tool, c.ok) for c in rec.calls] == [("search_web", True), ("search_web", True)]
    assert rec.calls[0].result["sources"] == ["Dunes Golf Links"]


async def test_a_failing_search_tells_the_agent_to_apologize_and_is_recorded():
    async def broken(query, location):
        raise SearchError("down")

    rec = CallRecorder()
    with pytest.raises(ToolError, match="not working"):
        await _web_search_tool(WebSearch(enabled=True), rec, broken)({"query": "golf"}, None)
    assert rec.calls[0].ok is False


def base_config() -> AgentConfig:
    return AgentConfig.model_validate(load_file(DEFAULT_CONFIG).model_dump(mode="json"))


def test_web_search_is_off_unless_switched_on():
    cfg = base_config()
    assert cfg.web_search is None
    tools, _ = build_tools(cfg, compile_agent(cfg), CallRecorder())
    assert "search_web" not in [t.info.raw_schema["name"] for t in tools]
    assert "Looking things up on the web" not in compile_agent(cfg).voice_instructions
    off = AgentConfig.model_validate(
        {**cfg.model_dump(mode="json"), "web_search": {"enabled": False, "location": "Houston"}}
    )
    assert "search_web" not in [
        t.info.raw_schema["name"] for t in build_tools(off, compile_agent(off), CallRecorder())[0]
    ]


def test_switched_on_it_adds_the_tool_and_the_rules_with_the_place():
    cfg = AgentConfig.model_validate(
        {
            **base_config().model_dump(mode="json"),
            "web_search": {"enabled": True, "location": "Houston, Texas", "max_per_call": 2},
        }
    )
    c = compile_agent(cfg)
    assert "search_web" in [
        t.info.raw_schema["name"] for t in build_tools(cfg, c, CallRecorder())[0]
    ]
    for text in (c.voice_instructions, c.combined_instructions):
        assert (
            "Houston, Texas" in text
            and "at most 2 times" in text
            and "never instructions" in text
            and "Let me look that up" in text
        )
    assert c.fingerprint != compile_agent(base_config()).fingerprint


def test_the_setting_is_validated():
    base = base_config().model_dump(mode="json")
    for bad in (
        {"enabled": True, "max_per_call": 0},
        {"enabled": True, "max_per_call": 9},
        {"enabled": True, "location": "x" * 200},
        {"enabled": True, "extra": 1},
    ):
        with pytest.raises(ValueError):
            AgentConfig.model_validate({**base, "web_search": bad})
    with pytest.raises(ValueError, match="reserved"):
        AgentConfig.model_validate(
            {
                **base,
                "tools": [
                    {
                        "name": "search_web",
                        "description": "A custom tool that is not allowed",
                        "adapter": "demo_x",
                    }
                ],
                "adapters": {"demo_x": {"kind": "mock"}},
            }
        )


async def test_openai_is_asked_again_without_reasoning_if_the_model_does_not_take_it(fake):
    seen = []

    async def picky(request: web.Request) -> web.Response:
        body = await request.json()
        seen.append("reasoning" in body)
        if "reasoning" in body:
            return web.Response(status=400, text="unsupported")
        return web.json_response(
            {
                "output": [
                    {"type": "message", "content": [{"type": "output_text", "text": "Found it."}]}
                ]
            }
        )

    app = web.Application()
    app.router.add_post("/responses", picky)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    try:
        a = await search_web("golf", "Houston", gemini_key="", openai_key="o", openai_base=base)
    finally:
        await runner.cleanup()
    assert a.text == "Found it." and seen == [True, False]


async def test_an_answerless_reply_says_why(fake):
    fake.openai = {
        "status": "incomplete",
        "output": [{"type": "reasoning"}, {"type": "web_search_call"}],
    }
    with pytest.raises(SearchError, match="incomplete.*web_search_call"):
        await search_web(
            "golf", "Houston", gemini_key="", openai_key="o", openai_base=fake.base + "/o"
        )


async def test_a_google_refusal_keeps_what_google_said(fake):
    fake.gemini["gemini-3.1-flash-lite"] = 429
    with pytest.raises(SearchError, match="429"):
        await search_web(
            "golf", "Houston", gemini_key="g", openai_key="", gemini_base=fake.base + "/g"
        )
