"""In-memory adapter driven entirely by config.

Each tool maps to one operation over a seeded collection, so a template can ship a working
demo (and evals can run against known state) without any backend:

    "options": {
      "seed": {"service_areas": [{"zip": "78701", "city": "Austin"}]},
      "tools": {
        "check_service_area": {"op": "lookup", "collection": "service_areas",
                               "match": {"zip": "zip_code"}}
      }
    }

Ops:
  lookup  first record whose fields equal the mapped args -> {"found", "record"}
  list    records matching the args that were given      -> {"results", "count"}
  create  append the args as a record with a new id      -> {"created", "id", ...args}
          (the same args again return the existing record with "duplicate": true, so a
          retry after a dropped connection never books twice)
  reply   a fixed response                               -> options["response"]

Each call gets its own copy of the seed, so one call never sees another call's writes.
``snapshot()``/``restore()`` carry that state across a session restart within one call.
"""

from __future__ import annotations

import copy
from typing import Any

from . import ToolFailed

_OPS = {"lookup", "list", "create", "reply"}


def _norm(v: Any) -> Any:
    return v.strip().lower() if isinstance(v, str) else v


class MockAdapter:
    def __init__(self, name: str, options: dict[str, Any]) -> None:
        self.name = name
        self._tools: dict[str, dict[str, Any]] = options.get("tools", {})
        for tool, spec in self._tools.items():
            if spec.get("op") not in _OPS:
                raise ValueError(f"mock adapter {name!r}: tool {tool!r} has unknown op")
        self.state: dict[str, list[dict[str, Any]]] = copy.deepcopy(options.get("seed", {}))
        self._next_id = 1001
        self.log: list[tuple[str, dict[str, Any], dict[str, Any]]] = []

    def _matches(self, record: dict[str, Any], match: dict[str, str], args: dict[str, Any]) -> bool:
        for field, arg in match.items():
            if arg not in args or args[arg] in (None, ""):
                continue
            if _norm(record.get(field)) != _norm(args[arg]):
                return False
        return True

    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        spec = self._tools.get(tool)
        if spec is None:
            raise ToolFailed(f"mock adapter {self.name!r} has no behavior for {tool!r}")
        op = spec["op"]
        rows = self.state.setdefault(spec.get("collection", tool), [])
        match: dict[str, str] = spec.get("match", {})

        if op == "lookup":
            hit = next((r for r in rows if self._matches(r, match, args)), None)
            result: dict[str, Any] = {"found": hit is not None}
            if hit is not None:
                result["record"] = hit
        elif op == "list":
            found = [r for r in rows if self._matches(r, match, args)]
            limit = int(spec.get("limit", 3))
            result = {"results": found[:limit], "count": len(found)}
        elif op == "create":
            existing = next(
                (r for r in rows if {k: v for k, v in r.items() if k != "id"} == args), None
            )
            if existing is not None:
                result = {"created": True, "duplicate": True, **existing}
            else:
                record = {"id": f"{spec.get('id_prefix', 'R')}-{self._next_id}", **args}
                self._next_id += 1
                rows.append(record)
                result = {"created": True, **record}
        else:
            result = copy.deepcopy(spec.get("response", {"ok": True}))

        self.log.append((tool, args, result))
        return result

    def snapshot(self) -> dict[str, Any]:
        return {"state": copy.deepcopy(self.state), "next_id": self._next_id}

    def restore(self, snap: dict[str, Any]) -> None:
        self.state = copy.deepcopy(snap.get("state", self.state))
        self._next_id = int(snap.get("next_id", self._next_id))
