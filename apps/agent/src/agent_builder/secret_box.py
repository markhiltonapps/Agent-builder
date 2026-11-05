"""Encrypt a secret before it is stored (a client's Votel key), with a key that lives only in the servers' environment.

The database holds only the encrypted text, so a copy of the database does not reveal the keys. ``SECRETS_KEY`` is a
Fernet key (``Fernet.generate_key()``); it is set on every server that reads or writes a stored secret.
"""

from __future__ import annotations

import os

from cryptography.fernet import Fernet, InvalidToken


class SecretError(Exception):
    """The secret could not be encrypted or read (no key set, or the stored text is not valid)."""


def _fernet(key: str | None = None) -> Fernet:
    raw = (key if key is not None else os.getenv("SECRETS_KEY", "")).strip()
    if not raw:
        raise SecretError("SECRETS_KEY is not set")
    try:
        return Fernet(raw.encode())
    except ValueError as e:
        raise SecretError("SECRETS_KEY is not a valid key") from e


def seal(plain: str, *, key: str | None = None) -> str:
    return _fernet(key).encrypt(plain.encode()).decode()


def unseal(sealed: str, *, key: str | None = None) -> str:
    try:
        return _fernet(key).decrypt(sealed.encode()).decode()
    except InvalidToken as e:
        raise SecretError("the stored secret cannot be read with this key") from e
