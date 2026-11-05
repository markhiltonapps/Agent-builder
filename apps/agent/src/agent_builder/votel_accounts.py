"""Which Votel account an agent's client uses.

Votel gives every account (and every sub-account) its own API key, and a key only reaches the account it was made in.
So each client can have its own: the client's Votel sub-account key, pasted under the client's Settings and kept
encrypted in ``client_votel_keys``. Whatever the agent does in Votel for that client (call notes, contacts and tasks,
appointment bookings, the list of booking services) is then done in the client's own sub-account. A client without a
key of its own uses the main Votel account, as before.

The agency-level work (the board of agents, importing agents, the client's own contact) always uses the main key.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import aiohttp

from . import supabase
from .secret_box import SecretError, seal, unseal
from .votel import VotelConfig, VotelError, call_tool, votel_config

log = logging.getLogger("agent_builder.votel_accounts")

_CACHE: dict[str, tuple[float, str | None]] = {}
CACHE_S = 60.0
_ACCOUNT = re.compile(
    r'Account this conversation acts in: "(?P<name>[^"]*)" \(id (?P<id>[0-9a-f-]{36})\)'
)


@dataclass(frozen=True)
class VotelAccount:
    id: str
    name: str


def parse_whoami(text: str) -> VotelAccount | None:
    m = _ACCOUNT.search(text)
    return VotelAccount(m["id"], m["name"]) if m else None


async def whoami(cfg: VotelConfig) -> VotelAccount:
    """The Votel account a key acts in. Raises ``VotelError`` if the key does not work."""
    found = parse_whoami(await call_tool(cfg, "whoami", {}))
    if found is None:
        raise VotelError("whoami: could not tell which account the key is for")
    return found


def _rest(creds: tuple[str, str]) -> tuple[str, dict[str, str]]:
    url, key = creds
    return f"{url.rstrip('/')}/rest/v1/client_votel_keys", supabase.headers(key)


async def _stored(
    account_id: str, creds: tuple[str, str] | None = None, timeout_s: float = 4.0
) -> dict | None:
    creds = creds or supabase.credentials()
    if creds is None:
        return None
    base, headers = _rest(creds)
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as http,
            http.get(
                base,
                params={
                    "account_id": f"eq.{account_id}",
                    "select": "encrypted_key,votel_account_name",
                },
                headers=headers,
            ) as r,
        ):
            if r.status >= 300:
                return None
            rows = await r.json()
    except (aiohttp.ClientError, TimeoutError, ValueError):
        log.warning("could not read a client's Votel key", exc_info=True)
        return None
    return rows[0] if rows else None


async def votel_config_for(
    account_id: str | None, *, creds: tuple[str, str] | None = None
) -> VotelConfig | None:
    """The Votel connection for this client: its own sub-account key if it has one, else the main account's."""
    main = votel_config()
    if not account_id:
        return main
    now = time.monotonic()
    hit = _CACHE.get(account_id)
    if hit and now - hit[0] < CACHE_S:
        key = hit[1]
    else:
        row = await _stored(account_id, creds)
        key = None
        if row:
            try:
                key = unseal(row["encrypted_key"])
            except SecretError:
                log.exception("a client's Votel key cannot be read; using the main account")
        _CACHE[account_id] = (now, key)
    if key:
        return VotelConfig(key=key, api_url=main.api_url if main else VotelConfig(key="").api_url)
    return main


def forget(account_id: str) -> None:
    _CACHE.pop(account_id, None)


async def status(account_id: str, *, creds: tuple[str, str] | None = None) -> dict[str, object]:
    row = await _stored(account_id, creds)
    return {"connected": bool(row), "account_name": (row or {}).get("votel_account_name") or ""}


async def save_key(
    account_id: str, key: str, *, creds: tuple[str, str] | None = None
) -> VotelAccount:
    """Check a sub-account key works and is not the main account's, then keep it (encrypted) for this client."""
    key = key.strip()
    if not key.startswith("sk_") or len(key) < 20 or any(c.isspace() for c in key):
        raise VotelError("that does not look like a Votel API key (it starts with sk_)")
    main = votel_config()
    base_url = main.api_url if main else VotelConfig(key="").api_url
    account = await whoami(VotelConfig(key=key, api_url=base_url))
    if main is not None:
        try:
            if (await whoami(main)).id == account.id:
                raise VotelError(
                    "that is your main Votel account's key. Use a key made inside the client's sub-account."
                )
        except VotelError as e:
            if "main Votel account" in str(e):
                raise
    creds = creds or supabase.credentials()
    if creds is None:
        raise VotelError("the database is not configured")
    try:
        sealed = seal(key)
    except SecretError as e:
        raise VotelError(f"keys cannot be stored yet: {e}") from e
    base, headers = _rest(creds)
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6)) as http,
            http.post(
                base,
                params={"on_conflict": "account_id"},
                data=json.dumps(
                    {
                        "account_id": account_id,
                        "encrypted_key": sealed,
                        "votel_account_name": account.name,
                        "votel_account_id": account.id,
                        "updated_at": datetime.now(UTC).isoformat(),
                    }
                ),
                headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            ) as r,
        ):
            if r.status >= 300:
                raise VotelError(f"the key could not be saved (database said {r.status})")
    except (aiohttp.ClientError, TimeoutError) as e:
        raise VotelError("the key could not be saved: the database is unreachable") from e
    forget(account_id)
    return account


async def clear_key(account_id: str, *, creds: tuple[str, str] | None = None) -> None:
    creds = creds or supabase.credentials()
    if creds is None:
        raise VotelError("the database is not configured")
    base, headers = _rest(creds)
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6)) as http,
            http.delete(
                base,
                params={"account_id": f"eq.{account_id}"},
                headers={**headers, "Prefer": "return=minimal"},
            ) as r,
        ):
            if r.status >= 300:
                raise VotelError(f"the key could not be removed (database said {r.status})")
    except (aiohttp.ClientError, TimeoutError) as e:
        raise VotelError("the key could not be removed: the database is unreachable") from e
    forget(account_id)
