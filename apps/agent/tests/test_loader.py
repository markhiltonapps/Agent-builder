"""Database agents: the worker runs the published version, and only that."""

import json

import aiohttp
import pytest
from aiohttp import web

from agent_builder import loader
from agent_builder.loader import DEFAULT_CONFIG, PublishedSource, load_file, resolve_config

AGENT = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def raw():
    return json.loads(DEFAULT_CONFIG.read_text())


class FakePostgrest:
    def __init__(self, raw):
        self.raw = raw
        self.version = 3
        self.down = False
        self.requests: list[dict] = []

    async def rpc(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.requests.append({"body": body, "headers": dict(request.headers)})
        if self.down:
            return web.Response(status=503)
        if body["p_agent"] == "bad":
            return web.Response(status=400)
        if body["p_agent"] != AGENT:
            return web.json_response([])
        return web.json_response(
            [
                {
                    "agent_id": AGENT,
                    "account_id": "22222222-2222-2222-2222-222222222222",
                    "version_id": f"v{self.version}",
                    "version": self.version,
                    "config": self.raw,
                }
            ]
        )


@pytest.fixture
async def db(raw):
    fake = FakePostgrest(raw)
    app = web.Application()
    app.router.add_post("/rest/v1/rpc/published_agent", fake.rpc)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    fake.url = f"http://127.0.0.1:{port}"
    yield fake
    await runner.cleanup()


async def test_loads_the_published_version(db):
    src = PublishedSource(db.url, "sb_secret_abc")
    got = await src.load(AGENT)
    assert got.source == "published"
    assert (got.agent_id, got.version, got.version_id) == (AGENT, 3, "v3")
    assert got.config == load_file(DEFAULT_CONFIG)
    sent = db.requests[0]
    assert sent["body"] == {"p_agent": AGENT}
    assert sent["headers"]["apikey"] == "sb_secret_abc"
    assert "Authorization" not in sent["headers"]  # new-style keys are not JWTs


async def test_legacy_jwt_key_is_also_sent_as_bearer(db):
    await PublishedSource(db.url, "eyJ.legacy.jwt").load(AGENT)
    assert db.requests[0]["headers"]["Authorization"] == "Bearer eyJ.legacy.jwt"


async def test_republish_is_picked_up_on_the_next_call(db):
    src = PublishedSource(db.url, "k")
    assert (await src.load(AGENT)).version == 3
    db.version = 4
    assert (await src.load(AGENT)).version == 4


async def test_unknown_or_unpublished_agent_is_an_error_not_a_default(db):
    src = PublishedSource(db.url, "k")
    with pytest.raises(LookupError, match="no published version"):
        await src.load("33333333-3333-3333-3333-333333333333")
    with pytest.raises(LookupError, match="not a valid agent id"):
        await src.load("bad")


async def test_database_outage_reuses_last_good_version(db):
    src = PublishedSource(db.url, "k")
    first = await src.load(AGENT)
    db.down = True
    assert await src.load(AGENT) == first


async def test_database_outage_with_nothing_cached_fails_the_call(db):
    db.down = True
    with pytest.raises(aiohttp.ClientError):
        await PublishedSource(db.url, "k").load(AGENT)


async def test_a_stored_config_that_fails_validation_is_rejected(db):
    db.raw = {**db.raw, "schema_version": 2}
    with pytest.raises(ValueError):
        await PublishedSource(db.url, "k").load(AGENT)


async def test_resolve_prefers_inline_then_agent_id_then_file(db, raw, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", db.url)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "k")
    monkeypatch.setattr(loader, "_source", None)
    monkeypatch.delenv("AGENT_ID", raising=False)

    assert (await resolve_config(None)).source == "file"
    assert (await resolve_config(json.dumps({"config": raw}))).source == "inline"
    got = await resolve_config(json.dumps({"agent_id": AGENT}))
    assert (got.source, got.version) == ("published", 3)

    monkeypatch.setenv("AGENT_ID", AGENT)
    assert (await resolve_config(None)).source == "published"
    # an explicit file in the dispatch beats the worker's default agent
    assert (await resolve_config(json.dumps({"config_path": str(DEFAULT_CONFIG)}))).source == "file"


async def test_agent_id_without_database_keys_says_so(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.setattr(loader, "_source", None)
    with pytest.raises(RuntimeError, match="SUPABASE_URL"):
        await resolve_config(json.dumps({"agent_id": AGENT}))
