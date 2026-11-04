from aiohttp import web

from agent_builder.preflight import clean_env, preflight


def test_clean_env_trims_space_newline_and_quotes_only_where_needed():
    env = {
        "OPENAI_API_KEY": "sk-abc \n",
        "LIVEKIT_API_KEY": ' "APIxyz" ',
        "LIVEKIT_API_SECRET": "already-clean",
        "UNRELATED": "  leave me  ",
    }
    assert sorted(clean_env(env)) == ["LIVEKIT_API_KEY", "OPENAI_API_KEY"]
    assert env["OPENAI_API_KEY"] == "sk-abc"
    assert env["LIVEKIT_API_KEY"] == "APIxyz"
    assert env["LIVEKIT_API_SECRET"] == "already-clean"
    assert env["UNRELATED"] == "  leave me  "  # only the known key variables are touched


async def _openai(aiohttp_server_port_holder):
    app = web.Application()

    async def models(request):
        ok = request.headers.get("Authorization") == "Bearer sk-good"
        return web.json_response({}, status=200 if ok else 401)

    app.router.add_get("/v1/models", models)
    app.router.add_get("/v1/models/gpt-live-1", models)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


async def test_preflight_reports_status_and_never_the_key():
    runner, port = await _openai(None)
    try:
        base = f"http://127.0.0.1:{port}/v1"
        good = await preflight({"OPENAI_API_KEY": "sk-good"}, openai_base=base)
        bad = await preflight({"OPENAI_API_KEY": "sk-bad "}, openai_base=base)
    finally:
        await runner.cleanup()
    assert any(line.endswith("(GET /models): 200") for line in good)
    assert any(line.endswith("(GET /models): 401") for line in bad)
    assert any("has_space=True" in line for line in bad)
    assert not any("sk-good" in line or "sk-bad" in line for line in good + bad)
