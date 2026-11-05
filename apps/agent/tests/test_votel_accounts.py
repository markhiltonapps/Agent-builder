"""A client's own Votel connection: stored encrypted, used for that client, the main account for everyone else."""

import pytest
from aiohttp import web
from cryptography.fernet import Fernet

from agent_builder import votel_accounts
from agent_builder.secret_box import SecretError, seal, unseal
from agent_builder.votel import VotelConfig, VotelError
from agent_builder.votel_accounts import parse_whoami, save_key, votel_config_for

ACCT = "22222222-2222-2222-2222-222222222222"
WHO = 'You are Mark <m@x.com> — role: owner, id: 1\nAccount this conversation acts in: "Test Hotel Group" (id 5d1c1e6e-0000-4000-8000-00000000abcd)\n'


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    votel_accounts._CACHE.clear()
    monkeypatch.setenv("SECRETS_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("VOTEL_API_KEY", "sk_main_key_for_the_agency_000")


class Db:
    """A stand-in for the client_votel_keys table."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.url = ""

    async def get(self, request: web.Request) -> web.Response:
        acct = request.query["account_id"].removeprefix("eq.")
        return web.json_response([self.rows[acct]] if acct in self.rows else [])

    async def post(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.rows[body["account_id"]] = body
        return web.Response(status=201)

    async def delete(self, request: web.Request) -> web.Response:
        self.rows.pop(request.query["account_id"].removeprefix("eq."), None)
        return web.Response(status=204)


@pytest.fixture
async def db():
    d = Db()
    app = web.Application()
    app.router.add_get("/rest/v1/client_votel_keys", d.get)
    app.router.add_post("/rest/v1/client_votel_keys", d.post)
    app.router.add_delete("/rest/v1/client_votel_keys", d.delete)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    d.url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    yield d
    await runner.cleanup()


def test_a_secret_is_unreadable_without_the_key_and_round_trips_with_it():
    sealed = seal("sk_secret_value_that_is_long")
    assert "sk_secret" not in sealed and unseal(sealed) == "sk_secret_value_that_is_long"
    with pytest.raises(SecretError):
        unseal(sealed, key=Fernet.generate_key().decode())
    with pytest.raises(SecretError):
        seal("x", key="")
    with pytest.raises(SecretError):
        seal("x", key="not a fernet key")


def test_the_account_a_key_acts_in_is_read_from_whoami():
    a = parse_whoami(WHO)
    assert a and a.name == "Test Hotel Group" and a.id.endswith("abcd")
    assert parse_whoami("nothing useful") is None


async def test_a_client_without_its_own_key_uses_the_main_account(db):
    cfg = await votel_config_for(ACCT, creds=(db.url, "sb_secret_x"))
    assert cfg is not None and cfg.key == "sk_main_key_for_the_agency_000"
    assert (await votel_config_for(None)).key == "sk_main_key_for_the_agency_000"


async def test_a_clients_saved_key_is_used_for_that_client_only(db, monkeypatch):
    calls = []

    async def fake_call(cfg, name, args, **kw):
        calls.append(cfg.key)
        return (
            WHO
            if cfg.key == "sk_sub_account_key_for_the_hotel_1"
            else 'Account this conversation acts in: "Mark Hilton" (id 36080530-7dbe-49ca-aab1-5277842b1a73)'
        )

    monkeypatch.setattr(votel_accounts, "call_tool", fake_call)
    creds = (db.url, "sb_secret_x")
    account = await save_key(ACCT, "sk_sub_account_key_for_the_hotel_1", creds=creds)
    assert account.name == "Test Hotel Group"
    stored = db.rows[ACCT]
    assert (
        "sk_sub_account" not in str(stored) and stored["votel_account_name"] == "Test Hotel Group"
    )
    mine = await votel_config_for(ACCT, creds=creds)
    assert mine.key == "sk_sub_account_key_for_the_hotel_1"
    other = await votel_config_for("33333333-3333-3333-3333-333333333333", creds=creds)
    assert other.key == "sk_main_key_for_the_agency_000"
    assert (await votel_accounts.status(ACCT, creds=creds)) == {
        "connected": True,
        "account_name": "Test Hotel Group",
    }
    await votel_accounts.clear_key(ACCT, creds=creds)
    assert (await votel_config_for(ACCT, creds=creds)).key == "sk_main_key_for_the_agency_000"
    assert (await votel_accounts.status(ACCT, creds=creds))["connected"] is False


async def test_the_main_accounts_own_key_is_refused_as_a_client_key(db, monkeypatch):
    async def same(cfg, name, args, **kw):
        return WHO

    monkeypatch.setattr(votel_accounts, "call_tool", same)
    with pytest.raises(VotelError, match="main Votel account"):
        await save_key(ACCT, "sk_main_key_for_the_agency_000", creds=(db.url, "sb_secret_x"))
    assert db.rows == {}


@pytest.mark.parametrize("bad", ["", "not-a-key", "sk_short", "sk_has a space in it_0000000"])
async def test_something_that_is_not_a_key_is_refused_before_asking_votel(db, bad):
    with pytest.raises(VotelError, match="does not look like"):
        await save_key(ACCT, bad, creds=(db.url, "sb_secret_x"))


async def test_a_key_votel_rejects_is_not_saved(db, monkeypatch):
    async def reject(cfg, name, args, **kw):
        raise VotelError("whoami: 401")

    monkeypatch.setattr(votel_accounts, "call_tool", reject)
    with pytest.raises(VotelError):
        await save_key(ACCT, "sk_sub_account_key_for_the_hotel_1", creds=(db.url, "sb_secret_x"))
    assert db.rows == {}


async def test_without_the_encryption_key_keys_cannot_be_stored_and_nothing_breaks(db, monkeypatch):
    monkeypatch.delenv("SECRETS_KEY")

    async def fake_call(cfg, name, args, **kw):
        return (
            WHO
            if cfg.key.startswith("sk_sub")
            else 'Account this conversation acts in: "Mark Hilton" (id 36080530-7dbe-49ca-aab1-5277842b1a73)'
        )

    monkeypatch.setattr(votel_accounts, "call_tool", fake_call)
    with pytest.raises(VotelError, match="cannot be stored"):
        await save_key(ACCT, "sk_sub_account_key_for_the_hotel_1", creds=(db.url, "sb_secret_x"))
    assert (
        await votel_config_for(ACCT, creds=(db.url, "sb_secret_x"))
    ).key == "sk_main_key_for_the_agency_000"


async def test_an_unreadable_stored_key_falls_back_to_the_main_account(db):
    db.rows[ACCT] = {"account_id": ACCT, "encrypted_key": "garbage", "votel_account_name": "x"}
    cfg = await votel_config_for(ACCT, creds=(db.url, "sb_secret_x"))
    assert isinstance(cfg, VotelConfig) and cfg.key == "sk_main_key_for_the_agency_000"
