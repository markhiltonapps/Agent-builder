"""The knowledge base on the agent side: what is read at the start of a call or chat, and the search tool."""

import json

import pytest
from aiohttp import web
from livekit.agents import ToolError
from test_chat import AGENT, FakeModel, Harness, _loaded, model  # noqa: F401  (model is a fixture)

from agent_builder import knowledge as kb_module
from agent_builder.chat_store import MemoryChatStore
from agent_builder.compiler import compile_agent
from agent_builder.knowledge import (
    Knowledge,
    Passage,
    apply_knowledge,
    knowledge_tools,
    load_knowledge,
    search,
)
from agent_builder.loader import DEFAULT_CONFIG, load_file
from agent_builder.tools import CallRecorder


class FakeDatabase:
    """Answers the two knowledge functions the way the real database would."""

    def __init__(self):
        self.for_agent: dict | int = {"count": 0, "total_chars": 0, "docs": []}
        self.found: list | int = []
        self.calls: list[tuple[str, dict]] = []
        self.url = ""

    async def rpc(self, request: web.Request) -> web.Response:
        name = request.match_info["name"]
        body = await request.json()
        self.calls.append((name, body))
        answer = self.for_agent if name == "knowledge_for_agent" else self.found
        if isinstance(answer, int):
            return web.Response(status=answer, text="no")
        return web.json_response(answer)


@pytest.fixture
async def db():
    fake = FakeDatabase()
    app = web.Application()
    app.router.add_post("/rest/v1/rpc/{name}", fake.rpc)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    fake.url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    yield fake
    await runner.cleanup()


def creds(db: FakeDatabase) -> tuple[str, str]:
    return (db.url, "sb_secret_test")


def compiled():
    return compile_agent(load_file(DEFAULT_CONFIG))


async def test_small_knowledge_is_read_whole(db):
    db.for_agent = {
        "count": 2,
        "total_chars": 80,
        "docs": [
            {"title": "Hours", "content": "Open 8 to 5."},
            {"title": "Prices", "content": "Cleaning is 99 dollars."},
        ],
    }
    kb = await load_knowledge(AGENT, creds=creds(db))
    assert kb is not None and kb.inline and kb.count == 2
    assert kb.docs == (("Hours", "Open 8 to 5."), ("Prices", "Cleaning is 99 dollars."))
    assert db.calls == [("knowledge_for_agent", {"p_agent": AGENT, "p_inline_max": 20000})]


async def test_large_knowledge_is_only_counted(db):
    db.for_agent = {"count": 30, "total_chars": 90000, "docs": []}
    kb = await load_knowledge(AGENT, creds=creds(db))
    assert kb is not None and not kb.inline and kb.count == 30


@pytest.mark.parametrize("answer", [{"count": 0, "total_chars": 0, "docs": []}, 500, {"oops": 1}])
async def test_no_knowledge_or_a_database_problem_means_the_agent_just_carries_on(db, answer):
    db.for_agent = answer
    assert await load_knowledge(AGENT, creds=creds(db)) is None


async def test_nothing_is_read_without_an_agent_or_a_database():
    assert await load_knowledge(None, creds=("http://x", "k")) is None
    assert await load_knowledge(AGENT) is None  # no credentials in the test environment
    assert await load_knowledge(AGENT, creds=("http://127.0.0.1:1", "k")) is None  # unreachable


def test_small_knowledge_goes_into_the_instructions_and_needs_no_tool():
    base = compiled()
    kb = Knowledge(1, 40, (("Hours", "Open 8 to 5, Monday to Friday."),))
    out = apply_knowledge(base, kb)
    for text in (out.voice_instructions, out.combined_instructions):
        assert text.startswith(base.voice_instructions[:50]) or base.voice_instructions in text
        assert "## Hours\nOpen 8 to 5, Monday to Friday." in text
        assert "Never make up facts" in text
    assert out.backend_instructions == base.backend_instructions
    assert out.fingerprint == base.fingerprint  # the fingerprint tracks the config alone
    assert knowledge_tools(AGENT, kb, CallRecorder()) == []


def test_large_knowledge_tells_the_agent_to_search_and_gives_it_the_tool():
    base = compiled()
    kb = Knowledge(30, 90000)
    out = apply_knowledge(base, kb)
    for text in (out.voice_instructions, out.combined_instructions, out.backend_instructions):
        assert "search_knowledge" in text
    (tool,) = knowledge_tools(AGENT, kb, CallRecorder())
    assert tool.info.raw_schema["name"] == "search_knowledge"
    assert tool.info.raw_schema["parameters"]["required"] == ["query"]


def test_no_knowledge_changes_nothing():
    base = compiled()
    assert apply_knowledge(base, None) is base
    assert apply_knowledge(base, Knowledge(0, 0)) is base
    assert knowledge_tools(AGENT, None, CallRecorder()) == []
    assert knowledge_tools(None, Knowledge(30, 90000), CallRecorder()) == []


async def test_search_asks_the_database_with_a_short_query_and_returns_passages(db):
    db.found = [
        {"title": "Hours", "heading": "Weekend", "content": "Saturday 9 to 1.", "rank": 0.4}
    ]
    got = await search(AGENT, "saturday " * 100, creds=creds(db))
    assert got == [Passage("Hours", "Weekend", "Saturday 9 to 1.")]
    ((name, body),) = db.calls
    assert name == "knowledge_search" and body["p_agent"] == AGENT and len(body["p_query"]) == 300


async def test_search_says_when_the_database_is_down(db):
    db.found = 500
    with pytest.raises(OSError):
        await search(AGENT, "hours", creds=creds(db))
    with pytest.raises(OSError):
        await search(AGENT, "hours", creds=("http://127.0.0.1:1", "k"))


async def run_tool(tool, **args):
    return await tool(args, None)


async def test_the_search_tool_returns_passages_and_records_the_lookup():
    recorder = CallRecorder()

    async def found(agent_id, query):
        assert agent_id == AGENT
        return [
            Passage("Hours", "Weekend", "Saturday 9 to 1."),
            Passage("Prices", "", "Cleaning 99."),
        ]

    (tool,) = knowledge_tools(AGENT, Knowledge(30, 90000), recorder, found)
    out = await run_tool(tool, query="  saturday   hours ")
    assert (
        'From "Hours > Weekend":\nSaturday 9 to 1.' in out and 'From "Prices":\nCleaning 99.' in out
    )
    assert "Answer only from the above" in out
    (call,) = recorder.calls
    assert (call.tool, call.args, call.ok, call.result, call.goal) == (
        "search_knowledge",
        {"query": "saturday hours"},
        True,
        {"found": 2},
        False,
    )


async def test_the_search_tool_says_so_when_nothing_matches_and_when_it_cannot_look():
    recorder = CallRecorder()

    async def none(agent_id, query):
        return []

    async def down(agent_id, query):
        raise OSError("db down")

    (tool,) = knowledge_tools(AGENT, Knowledge(30, 90000), recorder, none)
    assert await run_tool(tool, query="parking") == kb_module.NOT_FOUND
    (broken,) = knowledge_tools(AGENT, Knowledge(30, 90000), recorder, down)
    with pytest.raises(ToolError, match="could not be reached"):
        await run_tool(broken, query="parking")
    with pytest.raises(ToolError):
        await run_tool(tool, query="   ")
    assert [c.ok for c in recorder.calls] == [True, False]


# --- chat: the same knowledge, typed ------------------------------------------------------------


def chat_with(model, knowledge, searcher=None):  # noqa: F811
    h = Harness(model, store=MemoryChatStore())

    async def load_kb(agent_id):
        assert agent_id == AGENT
        return knowledge

    h.service = h.another_copy(store=MemoryChatStore(), knowledge=load_kb, searcher=searcher)
    return h


async def test_a_chat_answers_from_small_knowledge_in_its_instructions(model):  # noqa: F811
    h = chat_with(model, Knowledge(1, 30, (("Hours", "Open Saturdays 9 to 1."),)))
    sid, _ = await h.service.start(AGENT)
    await h.service.send(sid, "Are you open Saturday?")
    sent = model.requests[0]
    assert "Open Saturdays 9 to 1." in sent["instructions"]
    assert "search_knowledge" not in [t["name"] for t in sent.get("tools", [])]


async def test_a_chat_searches_large_knowledge_and_the_model_gets_the_passages_back(model):  # noqa: F811
    async def found(agent_id, query):
        return [Passage("Hours", "Weekend", "Open Saturdays 9 to 1.")]

    h = chat_with(model, Knowledge(30, 90000), found)
    model.script = [
        {
            "calls": [
                {
                    "type": "function_call",
                    "call_id": "c1",
                    "name": "search_knowledge",
                    "arguments": json.dumps({"query": "saturday hours"}),
                }
            ]
        },
        {"content": "Yes, 9 to 1 on Saturdays."},
    ]
    sid, _ = await h.service.start(AGENT)
    assert await h.service.send(sid, "Are you open Saturday?") == "Yes, 9 to 1 on Saturdays."
    assert "search_knowledge" in [t["name"] for t in model.requests[0]["tools"]]
    result = model.requests[1]["input"][0]
    assert result["type"] == "function_call_output" and "Open Saturdays 9 to 1." in result["output"]
    await h.service.end(sid)
    ((_, record),) = h.finished
    assert [c["tool"] for c in record["tool_calls"]] == ["search_knowledge"]


async def test_a_chat_with_no_knowledge_is_unchanged(model):  # noqa: F811
    h = chat_with(model, None)
    sid, _ = await h.service.start(AGENT)
    await h.service.send(sid, "hi")
    assert "Knowledge base" not in model.requests[0]["instructions"]
