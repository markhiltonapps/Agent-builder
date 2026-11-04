"""Resolve which agent config a call runs.

Step 1 reads a JSON file. Step 2 swaps the body of ``load_config`` for a database read of the
published version, keyed the same way, and nothing else in the worker changes.

Dispatch metadata (JSON, optional) may carry:
  {"config_path": "templates/home_services.json"}   a file to load
  {"config": {...}}                                  an inline config (tests, evals)
Otherwise ``AGENT_CONFIG`` names the file, defaulting to the home-services template.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

from .config import AgentConfig

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "templates" / "home_services.json"


@lru_cache(maxsize=64)
def _load_file(path: str, mtime: float) -> AgentConfig:
    return AgentConfig.model_validate_json(Path(path).read_text())


def load_file(path: str | Path) -> AgentConfig:
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    return _load_file(str(p), p.stat().st_mtime)


def load_config(metadata: str | None) -> AgentConfig:
    meta = json.loads(metadata) if metadata else {}
    if "config" in meta:
        return AgentConfig.model_validate(meta["config"])
    return load_file(meta.get("config_path") or os.getenv("AGENT_CONFIG") or DEFAULT_CONFIG)
