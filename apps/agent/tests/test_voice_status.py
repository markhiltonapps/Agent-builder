import pytest
from aiohttp import web

from agent_builder import voice_status


@pytest.fixture
async def providers():
    seen = {}

    async def openai(request: web.Request) -> web.Response:
        seen["openai_auth"] = request.headers.get("Authorization")
        return web.json_response({"id": "gpt-live-1"}, status=seen.get("openai_status", 200))

    async def google(request: web.Request) -> web.Response:
        seen["google_key"] = request.headers.get("x-goog-api-key")
        return web.json_response({}, status=seen.get("google_status", 200))

    app = web.Application()
    app.router.add_get("/v1/models/gpt-live-1", openai)
    app.router.add_get("/g/models/{name}", google)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    seen["openai_base"], seen["google_base"] = f"{base}/v1", f"{base}/g"
    yield seen
    await runner.cleanup()


async def test_both_providers_up(providers):
    env = {"OPENAI_API_KEY": "sk-x", "GEMINI_API_KEY": "g-x"}
    r = await voice_status.check(
        env, openai_base=providers["openai_base"], google_base=providers["google_base"]
    )
    assert r["primary"]["ok"] and r["backup"]["ok"] and r["backup"]["configured"] and r["failover"]
    assert providers["openai_auth"] == "Bearer sk-x" and providers["google_key"] == "g-x"


async def test_a_primary_outage_is_reported_and_the_backup_still_shows_up(providers):
    providers["openai_status"] = 503
    env = {"OPENAI_API_KEY": "sk-x", "GEMINI_API_KEY": "g-x"}
    r = await voice_status.check(
        env, openai_base=providers["openai_base"], google_base=providers["google_base"]
    )
    assert r["primary"]["ok"] is False and r["primary"]["status"] == 503
    assert r["backup"]["ok"] is True


async def test_no_gemini_key_means_no_backup(providers):
    r = await voice_status.check({"OPENAI_API_KEY": "sk-x"}, openai_base=providers["openai_base"])
    assert r["backup"] == {"name": "Google Gemini Live", "configured": False, "ok": False}
    assert r["failover"] is False


async def test_an_unreachable_provider_never_raises():
    r = await voice_status.check({"OPENAI_API_KEY": "k"}, openai_base="http://127.0.0.1:1/v1")
    assert r["primary"]["ok"] is False
