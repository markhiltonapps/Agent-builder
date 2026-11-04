"""Shared bits for talking to Supabase PostgREST with the project's secret key."""

from __future__ import annotations

import os


def credentials() -> tuple[str, str] | None:
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SECRET_KEY")
    return (url, key) if url and key else None


def headers(key: str) -> dict[str, str]:
    h = {"apikey": key, "Content-Type": "application/json"}
    if not key.startswith("sb_"):  # a legacy service_role JWT also goes as a bearer token
        h["Authorization"] = f"Bearer {key}"
    return h
