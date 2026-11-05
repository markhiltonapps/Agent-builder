"""Website embed: reading an agent's embed settings and counting calls, against a fake database."""

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from agent_builder import embed
from agent_builder.api import make_app

AGENT = "11111111-1111-4111-8111-111111111111"
VERSION = "33333333-3333-4333-8333-333333333333"
SECRET = "s" * 24
AUTH = {"Authorization": f"Bearer {SECRET}"}


class FakeDb:
    def __init__(self):
        self.agent = {
            "name": "Front Desk",
            "embed_enabled": True,
            "embed_origins": ["https://example.com"],
            "published_version_id": VERSION,
        }
        self.begin_result = "ok"
        self.begin_calls: list[dict] = []
        self.queries: list[dict] = []
        self.down = False

    async def agents(self, request: web.Request) -> web.Response:
        self.queries.append(dict(request.query))
        if self.down:
            return web.Response(status=500, text="boom")
        ok = request.query.get("id") == f"eq.{AGENT}"
        return web.json_response([self.agent] if ok else [])

    async def versions(self, request: web.Request) -> web.Response:
        return web.json_response([{"persona": {"business_name": "Brightline Home Services"}}])

    async def rpc_begin(self, request: web.Request) -> web.Response:
        self.begin_calls.append(await request.json())
        return web.json_response(self.begin_result)


@pytest.fixture
async def db():
    fake = FakeDb()
    app = web.Application()
    app.router.add_get("/rest/v1/agents", fake.agents)
    app.router.add_get("/rest/v1/agent_versions", fake.versions)
    app.router.add_post("/rest/v1/rpc/embed_begin", fake.rpc_begin)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    fake.creds = (f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}", "sb_secret_x")
    yield fake
    await runner.cleanup()


async def test_info_reads_the_settings_and_the_business_name(db):
    got = await embed.info(AGENT, creds=db.creds)
    assert got is not None
    assert (got.name, got.business, got.enabled) == ("Front Desk", "Brightline Home Services", True)
    assert got.origins == ["https://example.com"] and got.published is True


async def test_an_unpublished_agent_has_no_business_name_lookup(db):
    db.agent["published_version_id"] = None
    got = await embed.info(AGENT, creds=db.creds)
    assert got is not None and got.business == "" and got.published is False


async def test_unknown_or_malformed_ids_are_not_found_without_asking_the_database(db):
    assert await embed.info("22222222-2222-4222-8222-222222222222", creds=db.creds) is None
    assert await embed.info("not-a-uuid'; drop table agents", creds=db.creds) is None
    assert len(db.queries) == 1  # only the well-formed unknown id reached the database


async def test_a_database_error_is_an_embed_error(db):
    db.down = True
    with pytest.raises(embed.EmbedError):
        await embed.info(AGENT, creds=db.creds)


async def test_begin_returns_the_database_verdict(db):
    assert await embed.begin(AGENT, creds=db.creds) == "ok"
    assert db.begin_calls == [{"p_agent": AGENT}]
    for verdict in ("disabled", "unpublished", "limit"):
        db.begin_result = verdict
        assert await embed.begin(AGENT, creds=db.creds) == verdict


async def test_begin_treats_anything_unexpected_as_no(db):
    db.begin_result = "maybe"
    assert await embed.begin(AGENT, creds=db.creds) == "disabled"
    assert await embed.begin("nope", creds=db.creds) == "disabled"


@pytest.fixture
async def client(db, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", db.creds[0])
    monkeypatch.setenv("SUPABASE_SECRET_KEY", db.creds[1])
    async with TestClient(TestServer(make_app(SECRET))) as c:
        yield c


async def test_the_api_serves_info_and_begin_only_with_the_secret(client, db):
    assert (await client.get(f"/v1/embed/info?agent_id={AGENT}")).status == 401
    assert (await client.post("/v1/embed/begin", json={"agent_id": AGENT})).status == 401

    r = await client.get(f"/v1/embed/info?agent_id={AGENT}", headers=AUTH)
    assert r.status == 200 and (await r.json())["business"] == "Brightline Home Services"
    r = await client.post("/v1/embed/begin", json={"agent_id": AGENT}, headers=AUTH)
    assert await r.json() == {"status": "ok"}


async def test_the_api_reports_not_found_bad_requests_and_outages(client, db):
    missing = "22222222-2222-4222-8222-222222222222"
    assert (await client.get(f"/v1/embed/info?agent_id={missing}", headers=AUTH)).status == 404
    assert (await client.post("/v1/embed/begin", json={}, headers=AUTH)).status == 400
    db.down = True
    assert (await client.get(f"/v1/embed/info?agent_id={AGENT}", headers=AUTH)).status == 502
