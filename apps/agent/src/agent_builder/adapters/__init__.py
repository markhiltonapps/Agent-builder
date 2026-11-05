"""Adapters answer tool calls. A tool names an adapter; the adapter decides where data lives.

Kinds: ``mock`` (in-memory seed state, for demos and evals), ``http`` (the customer's own API,
Step 3) and ``disabled`` (the compiler drops tools bound to it).
"""

from __future__ import annotations

from typing import Any, Protocol

from ..config import AdapterConfig


class ToolFailed(Exception):
    """Raised by an adapter when a call should be reported to the model as failed."""


class Adapter(Protocol):
    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]: ...


def snapshot_adapters(adapters: dict[str, Adapter]) -> dict[str, Any]:
    """State to carry across a session restart. Only adapters that hold call state have it."""
    return {n: a.snapshot() for n, a in adapters.items() if hasattr(a, "snapshot")}


def restore_adapters(adapters: dict[str, Adapter], saved: dict[str, Any]) -> None:
    for name, snap in saved.items():
        if name in adapters and hasattr(adapters[name], "restore"):
            adapters[name].restore(snap)


def build_adapter(name: str, cfg: AdapterConfig) -> Adapter:
    if cfg.kind == "mock":
        if cfg.options.get("engine") == "hotel":
            from .hotel_demo import HotelDemoAdapter

            return HotelDemoAdapter(name, cfg.options)
        from .mock import MockAdapter

        return MockAdapter(name, cfg.options)
    if cfg.kind == "http":
        raise NotImplementedError("http adapter ships in Step 3")
    raise ValueError(f"adapter {name!r} is {cfg.kind}; no tool should reach it")
