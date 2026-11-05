import pytest
from aiohttp import web
from livekit.agents import ChatContext

from agent_builder.calls_store import call_row, save_call, source_for, transcript_lines
from agent_builder.loader import LoadedConfig

ACCOUNT = "22222222-2222-2222-2222-222222222222"
AGENT = "11111111-1111-1111-1111-111111111111"


def _loaded(**kw):
    base = {
        "config": None,
        "source": "published",
        "agent_id": AGENT,
        "account_id": ACCOUNT,
        "version_id": "v-id",
        "version": 3,
    }
    return LoadedConfig(**{**base, **kw})


def _record():
    chat = ChatContext.empty()
    chat.add_message(role="assistant", content="Thanks for calling Brightline.")
    chat.add_message(role="user", content="I need a quote for a leaking faucet")
    chat.add_message(role="user", content="   ")  # silence is not a line
    return {
        "room": "talk-11111111-abcd1234",
        "started_at": 1793815344.0,
        "duration_s": 62.5,
        "goal_reached": True,
        "transferred": False,
        "transfer_reason": None,
        "recoveries": 1,
        "voice_model": {"model": "gpt-live-1"},
        "config_fingerprint": "f763",
        "tool_calls": [{"tool": "get_quote", "ok": True}],
        "transcript": chat.to_dict(),
    }


def test_transcript_keeps_only_what_was_said_in_order():
    assert transcript_lines(_record()["transcript"]) == [
        {"who": "agent", "text": "Thanks for calling Brightline."},
        {"who": "caller", "text": "I need a quote for a leaking faucet"},
    ]


def test_call_row_maps_the_record_and_computes_the_end():
    row = call_row(_loaded(), _record(), source="browser")
    assert row["account_id"] == ACCOUNT and row["agent_id"] == AGENT
    assert (row["agent_version"], row["agent_version_id"]) == (3, "v-id")
    assert row["started_at"].startswith("2026-11-04") and row["ended_at"] > row["started_at"]
    assert row["goal_reached"] is True and row["recoveries"] == 1
    assert len(row["transcript"]) == 2 and row["tool_calls"] == [{"tool": "get_quote", "ok": True}]


def test_source_comes_from_the_room_name():
    assert source_for("talk-abc-123") == "browser"
    assert source_for("web-11111111-abcd1234") == "web"
    assert source_for("call-+15125550100_xyz") == "phone"


class FakeDb:
    def __init__(self, status=201):
        self.status = status
        self.posts: list[dict] = []

    async def post(self, request: web.Request) -> web.Response:
        self.posts.append(
            {
                "query": dict(request.query),
                "prefer": request.headers.get("Prefer"),
                "body": await request.json(),
            }
        )
        return (
            web.json_response([{"id": "call-id-1"}], status=self.status)
            if self.status < 300
            else web.Response(status=self.status, text="boom")
        )


@pytest.fixture
async def db():
    fake = FakeDb()
    app = web.Application()
    app.router.add_post("/rest/v1/calls", fake.post)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    fake.url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    yield fake
    await runner.cleanup()


async def test_save_call_posts_one_idempotent_row(db):
    assert await save_call(_loaded(), _record(), creds=(db.url, "sb_secret_x")) == "call-id-1"
    sent = db.posts[0]
    assert sent["query"] == {"on_conflict": "room,started_at"}
    assert "merge-duplicates" in sent["prefer"]
    assert sent["body"]["room"] == "talk-11111111-abcd1234"


async def test_file_templates_and_missing_keys_are_not_saved(db):
    assert (
        await save_call(_loaded(agent_id=None, account_id=None), _record(), creds=(db.url, "k"))
        is None
    )
    assert db.posts == []


async def test_a_database_error_returns_false_and_never_raises(db):
    db.status = 500
    assert await save_call(_loaded(), _record(), creds=(db.url, "k")) is None


async def test_an_unreachable_database_returns_false_and_never_raises():
    assert (
        await save_call(_loaded(), _record(), creds=("http://127.0.0.1:1", "k"), timeout_s=1)
        is None
    )
