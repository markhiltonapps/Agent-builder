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

from . import embed, votel_clients, votel_import
from .chat import ChatError, ChatService
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
            client_contact_id=str(body["client_contact_id"])
            if body.get("client_contact_id")
            else None,
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


async def embed_info(request: web.Request) -> web.Response:
    """GET ?agent_id= -> the embed's public name and which websites may show it."""
    try:
        found = await embed.info(request.query.get("agent_id", ""))
    except embed.EmbedError:
        return web.json_response({"error": "unavailable"}, status=502)
    if found is None:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(found.to_json())


async def embed_begin(request: web.Request) -> web.Response:
    """POST {"agent_id"} -> {"status": "ok" | "disabled" | "unpublished" | "limit"}. 'ok' counts a call."""
    try:
        body = await request.json()
        agent_id = str(body["agent_id"])
        kind = "chat" if body.get("kind") == "chat" else "voice"
    except (ValueError, KeyError, TypeError):
        raise web.HTTPBadRequest(
            text='{"error": "agent_id is required"}', content_type="application/json"
        ) from None
    try:
        return web.json_response({"status": await embed.begin(agent_id, kind)})
    except embed.EmbedError:
        return web.json_response({"error": "unavailable"}, status=502)


async def votel_agents(_request: web.Request) -> web.Response:
    """GET -> the AI agents in the connected Votel account, for the import picker."""
    cfg = votel_config()
    if cfg is None:
        return web.json_response({"ok": False, "error": "Votel is not connected."}, status=503)
    try:
        agents = await votel_import.list_agents(cfg)
    except VotelError as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)
    return web.json_response({"ok": True, "agents": [a.to_json() for a in agents]})


async def votel_bookables(_request: web.Request) -> web.Response:
    """GET -> the booking services in the connected Votel account, for the calendar setting."""
    cfg = votel_config()
    if cfg is None:
        return web.json_response({"ok": False, "error": "Votel is not connected."}, status=503)
    try:
        found = await votel_import.list_bookables(cfg)
    except VotelError as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)
    return web.json_response({"ok": True, "bookables": [b.to_json() for b in found]})


async def votel_import_agent(request: web.Request) -> web.Response:
    """POST {"agent_id"} -> {"ok": true, "name", "config", "summary"}: a draft made from a Votel agent."""
    cfg = votel_config()
    if cfg is None:
        return web.json_response({"ok": False, "error": "Votel is not connected."}, status=503)
    agent_id = (await _text(request, "agent_id", 64)).strip()
    try:
        digest = await votel_import.fetch_agent(cfg, agent_id)
        name = next(
            (a.name for a in await votel_import.list_agents(cfg) if a.id == agent_id.lower()),
            "Votel agent",
        )
    except VotelError as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)
    try:
        d = await draft(votel_import.as_brief(name, digest))
    except DraftError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)
    return web.json_response({"ok": True, "name": name, "config": d.config, "summary": d.summary})


async def votel_clients_list(_request: web.Request) -> web.Response:
    """GET -> the Votel contacts tagged as clients, for the "Add from Votel" picker."""
    cfg = votel_config()
    if cfg is None:
        return web.json_response({"ok": False, "error": "Votel is not connected."}, status=503)
    try:
        found = await votel_clients.list_clients(cfg)
    except VotelError as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)
    return web.json_response(
        {"ok": True, "tag": votel_clients.TAG, "clients": [c.to_json() for c in found]}
    )


async def votel_client_get(request: web.Request) -> web.Response:
    """POST {"contact_id"} -> {"ok": true, "client": {id, name, email, phone}} for a tagged contact."""
    cfg = votel_config()
    if cfg is None:
        return web.json_response({"ok": False, "error": "Votel is not connected."}, status=503)
    contact_id = (await _text(request, "contact_id", 64)).strip()
    try:
        client = await votel_clients.fetch_client(cfg, contact_id)
    except VotelError as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)
    return web.json_response({"ok": True, "client": client.to_json()})


async def votel_client_push(request: web.Request) -> web.Response:
    """POST {"name", "email"?, "phone"?, "contact_id"?, "app_url"?} -> {"ok": true, "contact_id"}.

    Makes sure the client has a tagged contact in Votel, creating one if needed.
    """
    cfg = votel_config()
    if cfg is None:
        return web.json_response({"ok": False, "error": "Votel is not connected."}, status=503)
    try:
        body = await request.json()
        name = str(body["name"]).strip()
        if not name:
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise web.HTTPBadRequest(
            text='{"error": "name is required"}', content_type="application/json"
        ) from None
    try:
        contact_id = await votel_clients.push_client(
            cfg,
            name=name,
            email=str(body.get("email") or "") or None,
            phone=str(body.get("phone") or "") or None,
            contact_id=str(body["contact_id"]) if body.get("contact_id") else None,
            app_url=str(body.get("app_url") or "") or None,
        )
    except VotelError as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=502)
    return web.json_response({"ok": True, "contact_id": contact_id})


CHAT = web.AppKey("chat", ChatService)
_CHAT_STATUS = {
    "disabled": 404,
    "unpublished": 409,
    "limit": 429,
    "busy": 503,
    "gone": 410,
    "too_long": 413,
    "empty": 400,
    "try_again": 502,
}


def _chat_failed(e: ChatError) -> web.Response:
    return web.json_response({"ok": False, "reason": e.code}, status=_CHAT_STATUS.get(e.code, 502))


async def chat_start(request: web.Request) -> web.Response:
    """POST {"agent_id"} -> {"ok": true, "session", "greeting"}. Counts one chat against the daily cap."""
    agent_id = await _text(request, "agent_id", 64)
    try:
        session, greeting = await request.app[CHAT].start(agent_id)
    except ChatError as e:
        return _chat_failed(e)
    return web.json_response({"ok": True, "session": session, "greeting": greeting})


async def chat_send(request: web.Request) -> web.Response:
    """POST {"session", "message"} -> {"ok": true, "reply"}."""
    session = await _text(request, "session", 64)
    message = await _text(request, "message", 4000)
    try:
        reply = await request.app[CHAT].send(session, message)
    except ChatError as e:
        return _chat_failed(e)
    return web.json_response({"ok": True, "reply": reply})


async def chat_end(request: web.Request) -> web.Response:
    """POST {"session"} -> {"ok": true}. Finishes the chat: summary, Calls, Votel."""
    session = await _text(request, "session", 64)
    await request.app[CHAT].end(session)
    return web.json_response({"ok": True})


async def schema(_request: web.Request) -> web.Response:
    return web.json_response(AgentConfig.model_json_schema())


async def healthz(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def make_app(secret: str, chat: ChatService | None = None) -> web.Application:
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
    app[CHAT] = chat or ChatService()

    async def finish_chats(app: web.Application) -> None:
        await app[CHAT].close()  # a chat in progress is saved when the server stops

    app.on_cleanup.append(finish_chats)
    app.router.add_post("/v1/validate", validate)
    app.router.add_post("/v1/compile", compile_)
    app.router.add_post("/v1/directory/sync", directory_sync)
    app.router.add_post("/v1/draft", draft_new)
    app.router.add_post("/v1/revise", draft_revise)
    app.router.add_get("/v1/embed/info", embed_info)
    app.router.add_post("/v1/embed/begin", embed_begin)
    app.router.add_get("/v1/votel/agents", votel_agents)
    app.router.add_get("/v1/votel/bookables", votel_bookables)
    app.router.add_post("/v1/votel/import", votel_import_agent)
    app.router.add_get("/v1/votel/clients", votel_clients_list)
    app.router.add_post("/v1/votel/client", votel_client_get)
    app.router.add_post("/v1/votel/client-push", votel_client_push)
    app.router.add_post("/v1/chat/start", chat_start)
    app.router.add_post("/v1/chat/send", chat_send)
    app.router.add_post("/v1/chat/end", chat_end)
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
