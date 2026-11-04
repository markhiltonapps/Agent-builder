"""Validate and compile endpoints for the web editor.

The editor must show exactly what the worker will send to the model, so it asks the same
Python code instead of porting the compiler. Stateless: nothing here touches the database.

    POST /v1/validate  {"config": {...}}  -> {"ok": bool, "errors": [{"path", "message"}]}
    POST /v1/compile   {"config": {...}}  -> compiled prompts, lines, tools, fingerprint
    GET  /v1/schema                       -> JSON Schema of AgentConfig
    GET  /healthz

Every /v1 call needs ``Authorization: Bearer $BUILDER_API_SECRET``.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
from typing import Any

from aiohttp import web
from pydantic import ValidationError

from .compiler import compile_agent
from .config import AgentConfig
from .draft import DraftError, draft
from .votel import VotelError, votel_config
from .votel_directory import AgentCard, sync_agent

log = logging.getLogger("agent_builder.api")

MAX_BODY_BYTES = 512 * 1024


def _errors(e: ValidationError) -> list[dict[str, str]]:
    return [
        {
            "path": ".".join(str(p) for p in err["loc"]),
            "message": err["msg"].removeprefix("Value error, "),
        }
        for err in e.errors(include_url=False)
    ]


async def _read_config(request: web.Request) -> Any:
    """The ``config`` member of the JSON body, or a 400 response."""
    try:
        body = await request.json()
    except ValueError:
        raise web.HTTPBadRequest(
            text='{"error": "body must be JSON"}', content_type="application/json"
        ) from None
    if not isinstance(body, dict) or "config" not in body:
        raise web.HTTPBadRequest(
            text='{"error": "body must be {\\"config\\": {...}}"}', content_type="application/json"
        )
    return body["config"]


async def validate(request: web.Request) -> web.Response:
    """Always 200 for a well-formed request; problems are reported in the body."""
    try:
        AgentConfig.model_validate(await _read_config(request))
    except ValidationError as e:
        return web.json_response({"ok": False, "errors": _errors(e)})
    return web.json_response({"ok": True, "errors": []})


async def compile_(request: web.Request) -> web.Response:
    try:
        cfg = AgentConfig.model_validate(await _read_config(request))
    except ValidationError as e:
        return web.json_response({"ok": False, "errors": _errors(e)}, status=422)
    c = compile_agent(cfg)
    return web.json_response(
        {
            "ok": True,
            "voice_instructions": c.voice_instructions,
            "backend_instructions": c.backend_instructions,
            "opening_line": c.opening_line,
            "still_there_line": c.still_there_line,
            "goodbye_line": c.goodbye_line,
            "tools": [
                {"name": t.name, "description": t.description, "schema": t.json_schema()}
                for t in c.tools
            ],
            "fingerprint": c.fingerprint,
        }
    )


async def _text(request: web.Request, key: str, limit: int) -> str:
    try:
        body = await request.json()
    except ValueError:
        raise web.HTTPBadRequest(
            text='{"error": "body must be JSON"}', content_type="application/json"
        ) from None
    value = body.get(key) if isinstance(body, dict) else None
    if not isinstance(value, str) or not value.strip():
        raise web.HTTPBadRequest(
            text=json.dumps({"error": f"{key} is required"}), content_type="application/json"
        )
    if len(value) > limit:
        raise web.HTTPBadRequest(
            text=json.dumps({"error": f"{key} is too long"}), content_type="application/json"
        )
    return value.strip()


async def draft_new(request: web.Request) -> web.Response:
    """POST {"description": "..."} -> {"ok": true, "config": {...}, "summary": "..."}"""
    description = await _text(request, "description", 4000)
    try:
        d = await draft(description)
    except DraftError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)
    return web.json_response({"ok": True, "config": d.config, "summary": d.summary})


async def draft_revise(request: web.Request) -> web.Response:
    """POST {"config": {...}, "instruction": "..."} -> {"ok": true, "config": {...}, "summary": "..."}"""
    instruction = await _text(request, "instruction", 2000)
    existing = await _read_config(request)
    try:
        current = AgentConfig.model_validate(existing).model_dump(mode="json")
    except ValidationError as e:
        return web.json_response({"ok": False, "errors": _errors(e)}, status=422)
    try:
        d = await draft(instruction, existing=current)
    except DraftError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)
    return web.json_response({"ok": True, "config": d.config, "summary": d.summary})


async def directory_sync(request: web.Request) -> web.Response:
    """POST one agent's details -> create or update its card on Votel's "Agent Builder OS" board."""
    cfg = votel_config()
    if cfg is None:
        return web.json_response({"ok": False, "error": "Votel is not connected."}, status=503)
    try:
        body = await request.json()
        card = AgentCard(
            agent_id=str(body["agent_id"]),
            name=str(body["name"]),
            workspace=str(body.get("workspace", "")),
            business=str(body.get("business", "")),
            about=str(body.get("about", "")),
            live_version=body.get("live_version"),
            app_url=str(body["app_url"]),
            retired=bool(body.get("retired")),
        )
    except (ValueError, KeyError, TypeError):
        raise web.HTTPBadRequest(
            text='{"error": "agent_id, name and app_url are required"}',
            content_type="application/json",
        ) from None
    try:
        synced = await sync_agent(cfg, card, str(body["task_id"]) if body.get("task_id") else None)
    except VotelError as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)
    return web.json_response({"ok": True, "result": synced.result, "task_id": synced.task_id})


async def schema(_request: web.Request) -> web.Response:
    return web.json_response(AgentConfig.model_json_schema())


async def healthz(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def make_app(secret: str) -> web.Application:
    if len(secret) < 16:
        raise ValueError("BUILDER_API_SECRET must be at least 16 characters")

    @web.middleware
    async def auth(request: web.Request, handler: Any) -> web.StreamResponse:
        if request.path.startswith("/v1/"):
            given = request.headers.get("Authorization", "").removeprefix("Bearer ")
            if not hmac.compare_digest(given.encode(), secret.encode()):
                return web.json_response({"error": "unauthorized"}, status=401)
        return await handler(request)

    app = web.Application(middlewares=[auth], client_max_size=MAX_BODY_BYTES)
    app.router.add_post("/v1/validate", validate)
    app.router.add_post("/v1/compile", compile_)
    app.router.add_post("/v1/directory/sync", directory_sync)
    app.router.add_post("/v1/draft", draft_new)
    app.router.add_post("/v1/revise", draft_revise)
    app.router.add_get("/v1/schema", schema)
    app.router.add_get("/healthz", healthz)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    secret = os.getenv("BUILDER_API_SECRET", "")
    port = int(os.getenv("PORT", "8081"))
    web.run_app(make_app(secret), host=os.getenv("HOST", "0.0.0.0"), port=port)


if __name__ == "__main__":
    main()
