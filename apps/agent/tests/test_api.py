import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from agent_builder.api import make_app
from agent_builder.chat import ChatError
from agent_builder.compiler import compile_agent
from agent_builder.loader import DEFAULT_CONFIG, load_file

SECRET = "s" * 24
AUTH = {"Authorization": f"Bearer {SECRET}"}


@pytest.fixture
async def client():
    async with TestClient(TestServer(make_app(SECRET))) as c:
        yield c


@pytest.fixture
def raw():
    return json.loads(DEFAULT_CONFIG.read_text())


def test_short_secret_is_refused():
    with pytest.raises(ValueError):
        make_app("short")


async def test_v1_requires_the_secret(client, raw):
    assert (await client.post("/v1/compile", json={"config": raw})).status == 401
    bad = {"Authorization": "Bearer nope"}
    assert (await client.post("/v1/compile", json={"config": raw}, headers=bad)).status == 401
    assert (await client.get("/healthz")).status == 200


async def test_compile_matches_what_the_worker_compiles(client, raw):
    r = await client.post("/v1/compile", json={"config": raw}, headers=AUTH)
    assert r.status == 200
    body = await r.json()
    want = compile_agent(load_file(DEFAULT_CONFIG))
    assert body["voice_instructions"] == want.voice_instructions
    assert body["fingerprint"] == want.fingerprint
    assert body["opening_line"].startswith("Thanks for calling Brightline")
    assert {t["name"] for t in body["tools"]} == {t.name for t in want.tools}


async def test_validate_reports_each_problem_with_its_path(client, raw):
    raw["greetings"]["opening"] = "Hi {nope}"
    r = await client.post("/v1/validate", json={"config": raw}, headers=AUTH)
    body = await r.json()
    assert r.status == 200 and body["ok"] is False
    assert any(e["path"] == "greetings.opening" and "nope" in e["message"] for e in body["errors"])
    assert not any(e["message"].startswith("Value error") for e in body["errors"])


async def test_cross_field_problems_are_reported_once_fields_are_valid(client, raw):
    raw["tools"][0]["adapter"] = "ghost"
    body = await (await client.post("/v1/validate", json={"config": raw}, headers=AUTH)).json()
    assert body["ok"] is False and any("ghost" in e["message"] for e in body["errors"])


async def test_validate_ok(client, raw):
    r = await client.post("/v1/validate", json={"config": raw}, headers=AUTH)
    assert await r.json() == {"ok": True, "errors": []}


async def test_compile_of_an_invalid_config_is_422(client, raw):
    raw["persona"]["tone"] = "sarcastic"
    r = await client.post("/v1/compile", json={"config": raw}, headers=AUTH)
    assert r.status == 422 and (await r.json())["ok"] is False


async def test_malformed_bodies_are_400(client):
    assert (await client.post("/v1/compile", data="not json", headers=AUTH)).status == 400
    assert (await client.post("/v1/validate", json={"nope": 1}, headers=AUTH)).status == 400


async def test_schema_endpoint(client):
    body = await (await client.get("/v1/schema", headers=AUTH)).json()
    assert "persona" in body["properties"]


async def test_a_booking_link_is_validated_with_a_plain_message_and_reaches_the_prompt(client, raw):
    raw["booking"] = {"url": "", "channel": "sms"}
    r = await client.post("/v1/validate", json={"config": raw}, headers=AUTH)
    body = await r.json()
    assert body["ok"] is False
    assert any(
        e["path"] == "booking.url" and "starting with https://" in e["message"]
        for e in body["errors"]
    )

    raw["booking"] = {"url": "https://book.example.com/book/estimate", "channel": "sms"}
    r = await client.post("/v1/compile", json={"config": raw}, headers=AUTH)
    assert r.status == 200 and "link by text" in (await r.json())["voice_instructions"]


class FakeChat:
    def __init__(self):
        self.calls: list[tuple] = []

    async def start(self, agent_id):
        self.calls.append(("start", agent_id))
        if agent_id == "limit":
            raise ChatError("limit")
        return "sess1", "Hi, how can I help?"

    async def send(self, session, message):
        self.calls.append(("send", session, message))
        if session == "gone":
            raise ChatError("gone")
        return f"You said: {message}"

    async def end(self, session):
        self.calls.append(("end", session))
        return True

    async def close(self):
        self.calls.append(("close",))


async def test_chat_endpoints_start_send_and_end():
    fake = FakeChat()
    async with TestClient(TestServer(make_app(SECRET, chat=fake))) as c:
        assert (await c.post("/v1/chat/start", json={"agent_id": "a"})).status == 401
        r = await c.post("/v1/chat/start", json={"agent_id": "a"}, headers=AUTH)
        assert await r.json() == {"ok": True, "session": "sess1", "greeting": "Hi, how can I help?"}
        r = await c.post(
            "/v1/chat/send", json={"session": "sess1", "message": "hello"}, headers=AUTH
        )
        assert await r.json() == {"ok": True, "reply": "You said: hello"}
        r = await c.post("/v1/chat/end", json={"session": "sess1"}, headers=AUTH)
        assert (await r.json())["ok"] is True
    assert fake.calls == [("start", "a"), ("send", "sess1", "hello"), ("end", "sess1"), ("close",)]


async def test_chat_problems_come_back_with_a_reason_and_a_status():
    async with TestClient(TestServer(make_app(SECRET, chat=FakeChat()))) as c:
        r = await c.post("/v1/chat/start", json={"agent_id": "limit"}, headers=AUTH)
        assert (r.status, await r.json()) == (429, {"ok": False, "reason": "limit"})
        r = await c.post("/v1/chat/send", json={"session": "gone", "message": "x"}, headers=AUTH)
        assert (r.status, (await r.json())["reason"]) == (410, "gone")
        assert (await c.post("/v1/chat/send", json={"session": "s"}, headers=AUTH)).status == 400
        long = await c.post(
            "/v1/chat/send", json={"session": "s", "message": "x" * 4001}, headers=AUTH
        )
        assert long.status == 400
