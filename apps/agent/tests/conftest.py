"""Tests never reach a real service, whatever the shell they run in has set.

A developer's or a cloud session's shell may carry the production Supabase and Votel keys. Anything
a test wants from the database or Votel is passed in by the test (a stand-in server or store); a
test that forgets must find nothing configured, not production.
"""

import os

import pytest

_REAL_SERVICES = (
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_ANON_KEY",
    "VOTEL_API_KEY",
    "VOTEL_MCP_URL",
)


@pytest.fixture(autouse=True)
def _no_real_services(monkeypatch):
    for name in list(os.environ):
        if name in _REAL_SERVICES or name.startswith("SUPABASE_"):
            monkeypatch.delenv(name, raising=False)
