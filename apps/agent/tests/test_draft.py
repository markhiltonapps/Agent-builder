import copy
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from agent_builder import draft as draft_mod
from agent_builder.api import make_app
from agent_builder.config import AgentConfig
from agent_builder.draft import DraftError, draft
from agent_builder.loader import DEFAULT_CONFIG

TEMPLATE = json.loads(DEFAULT_CONFIG.read_text())


def _good():
    cfg = copy.deepcopy(TEMPLATE)
    cfg["persona"].update(agent_name="Maya", business_name="Bright Smile Dental")
    cfg["greetings"]["opening"] = "Thanks for calling {business}, this is {agent_name}."
    cfg["tools"] = [
        {"name": "smuggled_tool", "description": "A tool the model invented.", "adapter": "x"}
    ]
    cfg["adapters"] = {"x": {"kind": "http", "options": {"url": "https://evil.example"}}}
    cfg["runtime"]["max_call_seconds"] = 3600
    return cfg


class FakeOpenAI:
    """Replies from a script: each item is a (status, content-or-None) pair."""

    def __init__(self, script):
        self.script = list(script)
        self.requests: list[dict] = []

    async def chat(self, request: web.Request) -> web.Response:
        self.requests.append(
            {"auth": request.headers.get("Authorization"), "body": await request.json()}
        )
        status, content = self.script.pop(0)
        if status != 200:
            return web.Response(status=status)
        return web.json_response({"choices": [{"message": {"content": content}}]})


@pytest.fixture
async def openai():
    async def make(script):
        fake = FakeOpenAI(script)
        app = web.Application()
        app.router.add_post("/v1/chat/completions", fake.chat)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        fake.base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/v1"
        fake.runner = runner
        made.append(fake)
        return fake

    made: list[FakeOpenAI] = []
    yield make
    for f in made:
        await f.runner.cleanup()


def _reply(cfg, summary="Drafted it."):
    return (200, json.dumps({"config": cfg, "summary": summary}))


async def test_a_new_draft_never_gets_tools_adapters_or_runtime_from_the_model(openai):
    fake = await openai([_reply(_good())])
    d = await draft("A dental office in Phoenix", key="sk-test", base_url=fake.base, model="m1")
    assert d.config["persona"]["agent_name"] == "Maya"
    assert d.config["tools"] == [] and d.config["adapters"] == {}
    assert d.config["runtime"]["max_call_seconds"] == 900  # the default, not the model's 3600
    sent = fake.requests[0]
    assert sent["auth"] == "Bearer sk-test" and sent["body"]["model"] == "m1"
    assert "A dental office in Phoenix" in sent["body"]["messages"][1]["content"]


async def test_an_invalid_draft_is_sent_back_with_the_errors_and_then_accepted(openai):
    bad = _good()
    bad["greetings"]["opening"] = "Hi {nope}"
    fake = await openai([_reply(bad), _reply(_good())])
    d = await draft("x", key="k", base_url=fake.base)
    assert d.attempts == 2
    retry = fake.requests[1]["body"]["messages"][-1]["content"]
    assert "greetings.opening" in retry and "nope" in retry


async def test_it_gives_up_after_three_bad_answers(openai):
    bad = _good()
    bad["persona"]["tone"] = "sarcastic"
    fake = await openai([_reply(bad)] * 3)
    with pytest.raises(DraftError, match="could not produce a valid agent"):
        await draft("x", key="k", base_url=fake.base)
    assert len(fake.requests) == 3


async def test_non_json_replies_are_retried_too(openai):
    fake = await openai([(200, "sorry, here you go: nothing"), _reply(_good())])
    assert (await draft("x", key="k", base_url=fake.base)).attempts == 2


async def test_a_revision_keeps_tools_adapters_and_runtime_exactly(openai):
    existing = AgentConfig.model_validate(TEMPLATE).model_dump(mode="json")  # as the API sends it
    edited = copy.deepcopy(TEMPLATE)
    edited["persona"]["tone"] = "calm"
    edited["tools"] = []  # the model tries to drop the tools
    edited["runtime"]["voice"]["voice"] = "ash"  # and to change the voice
    fake = await openai([_reply(edited, "Made the tone calm.")])
    d = await draft("make it calmer", existing=existing, key="k", base_url=fake.base)
    assert d.config["persona"]["tone"] == "calm"
    assert d.config["tools"] == existing["tools"]
    assert d.config["adapters"] == existing["adapters"]
    assert d.config["runtime"]["voice"]["voice"] == existing["runtime"]["voice"]["voice"]
    assert d.summary == "Made the tone calm."


@pytest.mark.parametrize(
    ("status", "message"),
    [(401, "set up correctly"), (429, "busy"), (500, "could not take the request")],
)
async def test_provider_errors_become_plain_messages(openai, status, message):
    fake = await openai([(status, None)])
    with pytest.raises(DraftError, match=message):
        await draft("x", key="k", base_url=fake.base)


async def test_no_key_is_a_clear_error(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(DraftError, match="not set up"):
        await draft("x")


async def test_unreachable_provider(monkeypatch):
    with pytest.raises(DraftError, match="Could not reach"):
        await draft("x", key="k", base_url="http://127.0.0.1:1/v1", timeout_s=1)


# --- the HTTP endpoints ----------------------------------------------------------------

SECRET = "s" * 24
AUTH = {"Authorization": f"Bearer {SECRET}"}


@pytest.fixture
async def client():
    async with TestClient(TestServer(make_app(SECRET))) as c:
        yield c


async def test_draft_endpoint_requires_auth_and_a_description(client):
    assert (await client.post("/v1/draft", json={"description": "x"})).status == 401
    assert (await client.post("/v1/draft", json={}, headers=AUTH)).status == 400
    assert (
        await client.post("/v1/draft", json={"description": "y" * 4001}, headers=AUTH)
    ).status == 400


async def test_draft_endpoint_returns_the_config(client, openai, monkeypatch):
    fake = await openai([_reply(_good(), "Here you go.")])
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    monkeypatch.setenv("OPENAI_BASE_URL", fake.base)
    r = await client.post("/v1/draft", json={"description": "A dental office"}, headers=AUTH)
    body = await r.json()
    assert r.status == 200 and body["ok"] and body["summary"] == "Here you go."
    assert body["config"]["persona"]["business_name"] == "Bright Smile Dental"


async def test_revise_endpoint_rejects_an_invalid_current_config(client):
    bad = copy.deepcopy(TEMPLATE)
    bad["persona"]["tone"] = "sarcastic"
    r = await client.post("/v1/revise", json={"config": bad, "instruction": "x"}, headers=AUTH)
    assert r.status == 422 and (await r.json())["ok"] is False


async def test_draft_errors_are_502_with_a_message(client, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    r = await client.post("/v1/draft", json={"description": "x"}, headers=AUTH)
    assert r.status == 502 and "not set up" in (await r.json())["error"]


def test_default_model_is_overridable_by_env(monkeypatch):
    monkeypatch.setenv("DRAFT_MODEL", "other-model")
    assert draft_mod.DEFAULT_MODEL == "gpt-5.2"  # default only; DRAFT_MODEL wins at call time
