"""The Voice Agents board in Votel, against a fake Votel that keeps state like the real one."""

import asyncio
import socket
import uuid

import pytest
import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from agent_builder.votel import VotelConfig
from agent_builder.votel_directory import (
    LIVE,
    NOT_LIVE,
    PROJECT,
    RETIRED,
    TEMPLATE,
    AgentCard,
    sync_agent,
)

AGENT = "9bef4c7c-5c02-46fa-b325-f491a06c9d0c"


class FakeVotel:
    def __init__(self):
        self.projects = ["Default"]
        self.templates = {"Development": str(uuid.uuid4())}
        self.tasks: list[dict] = []
        self.calls: list[tuple[str, dict]] = []
        self.url = ""


def _build(f: FakeVotel) -> FastMCP:
    mcp = FastMCP(
        "fake",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    @mcp.tool()
    def list_projects() -> str:
        f.calls.append(("list_projects", {}))
        return f"Found {len(f.projects)} project(s):\n\n" + "\n".join(
            f"- {p} | 8 status(es) | id: {uuid.uuid4()}" for p in f.projects
        )

    @mcp.tool()
    def list_status_templates() -> str:
        f.calls.append(("list_status_templates", {}))
        return "Found:\n\n" + "\n".join(
            f"- {n} | id: {i} | 8 status(es)" for n, i in f.templates.items()
        )

    @mcp.tool()
    def create_status_template(name: str, statuses: list[dict] | None = None) -> str:
        f.calls.append(("create_status_template", {"name": name, "statuses": statuses}))
        f.templates[name] = str(uuid.uuid4())
        return f'Status template "{name}" created.\n  ID: {f.templates[name]}'

    @mcp.tool()
    def create_project(
        name: str, status_template_id: str, description: str = "", color: str = ""
    ) -> str:
        f.calls.append(("create_project", {"name": name, "status_template_id": status_template_id}))
        f.projects.append(name)
        return f'Project "{name}" created. ID: {uuid.uuid4()}'

    @mcp.tool()
    def list_tasks(project: str = "", search: str = "", limit: int = 25) -> str:
        f.calls.append(("list_tasks", {"project": project, "search": search}))
        hits = [
            t for t in f.tasks if t["project"] == project and search.lower() in t["title"].lower()
        ]
        if not hits:
            return "No tasks found."
        return f"Found {len(hits)} task(s):\n\n" + "\n".join(
            f"- {t['title']} | {t['status']} | id: {t['id']}" for t in hits
        )

    @mcp.tool()
    def create_task(
        title: str,
        project: str = "",
        status: str = "",
        description: str = "",
        tags: list[str] | None = None,
    ) -> str:
        f.calls.append(("create_task", {"title": title, "project": project, "status": status}))
        t = {
            "id": str(uuid.uuid4()),
            "title": title,
            "project": project,
            "status": status,
            "description": description,
        }
        f.tasks.append(t)
        return f'Task "{title}" created!\n  ID: {t["id"]}'

    @mcp.tool()
    def get_task(task_id: str) -> str:
        f.calls.append(("get_task", {"task_id": task_id}))
        t = next((t for t in f.tasks if t["id"] == task_id), None)
        if not t:
            raise ValueError("Task not found")
        return f"Task: {t['title']}\n  Status: {t['status']}\n\n{t['description']}"

    @mcp.tool()
    def update_task(task_id: str, title: str = "", status: str = "", description: str = "") -> str:
        f.calls.append(("update_task", {"task_id": task_id, "title": title, "status": status}))
        t = next((t for t in f.tasks if t["id"] == task_id), None)
        if not t:
            raise ValueError("Task not found")
        t.update(
            {
                k: v
                for k, v in {"title": title, "status": status, "description": description}.items()
                if v
            }
        )
        return "Task updated."

    return mcp


@pytest.fixture
async def votel():
    fake = FakeVotel()
    app = _build(fake).streamable_http_app()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    fake.url = f"http://127.0.0.1:{port}"
    yield fake
    server.should_exit = True
    await task


def _card(**kw):
    base = {
        "agent_id": AGENT,
        "name": "Front Desk",
        "workspace": "Test",
        "business": "Brightline Home Services",
        "about": "Plumbing, HVAC and electrical in Austin.",
        "live_version": None,
        "app_url": "https://app.test/",
    }
    return AgentCard(**{**base, **kw})


def _cfg(f):
    return VotelConfig(key="sk_x", api_url=f.url)


def test_the_card_status_follows_the_agent():
    assert _card().status == NOT_LIVE
    assert _card(live_version=3).status == LIVE
    assert _card(live_version=3, retired=True).status == RETIRED


def test_the_card_text_links_back_and_carries_the_agent_id():
    text = _card(live_version=2).description()
    assert "Live version: 2" in text and "https://app.test/agents/" + AGENT in text
    assert "https://app.test/calls?agent=" + AGENT in text and f"Agent ID: {AGENT}" in text
    assert "Not published yet." in _card().description()


async def test_the_first_sync_creates_the_board_its_statuses_and_the_card(votel):
    synced = await sync_agent(_cfg(votel), _card())
    assert synced.result == "created"
    names = [n for n, _ in votel.calls]
    assert (
        names.index("create_status_template")
        < names.index("create_project")
        < names.index("create_task")
    )
    template = next(a for n, a in votel.calls if n == "create_status_template")
    assert template["name"] == TEMPLATE and [s["name"] for s in template["statuses"]] == [
        NOT_LIVE,
        LIVE,
        RETIRED,
    ]
    assert PROJECT in votel.projects
    (task,) = votel.tasks
    assert synced.task_id == task["id"]
    assert (
        task["project"] == PROJECT and task["status"] == NOT_LIVE and AGENT in task["description"]
    )


async def test_syncing_again_with_the_remembered_id_updates_that_card(votel):
    first = await sync_agent(_cfg(votel), _card())
    votel.calls.clear()
    second = await sync_agent(
        _cfg(votel), _card(live_version=2, name="Front Desk (main)"), first.task_id
    )
    assert (second.result, second.task_id) == ("updated", first.task_id)
    assert len(votel.tasks) == 1
    assert votel.tasks[0]["status"] == LIVE and votel.tasks[0]["title"] == "Front Desk (main)"
    names = [n for n, _ in votel.calls]
    assert "create_project" not in names and "list_tasks" not in names  # no searching needed


async def test_a_lost_id_finds_the_card_by_name_and_agent_id_without_a_duplicate(votel):
    first = await sync_agent(_cfg(votel), _card())
    again = await sync_agent(_cfg(votel), _card(live_version=1))
    assert (again.result, again.task_id) == ("updated", first.task_id)
    assert len(votel.tasks) == 1 and votel.tasks[0]["status"] == LIVE


async def test_a_deleted_card_is_made_again(votel):
    first = await sync_agent(_cfg(votel), _card())
    votel.tasks.clear()
    again = await sync_agent(_cfg(votel), _card(), first.task_id)
    assert again.result == "created" and again.task_id != first.task_id
    assert len(votel.tasks) == 1


async def test_agents_with_the_same_name_keep_separate_cards(votel):
    other = "aaaaaaaa-0000-4000-8000-000000000001"
    a = await sync_agent(_cfg(votel), _card())
    b = await sync_agent(_cfg(votel), _card(agent_id=other))
    assert a.task_id != b.task_id and len(votel.tasks) == 2
    # With no remembered ids each one still finds its own card.
    a2 = await sync_agent(_cfg(votel), _card())
    b2 = await sync_agent(_cfg(votel), _card(agent_id=other))
    assert (a2.task_id, b2.task_id) == (a.task_id, b.task_id) and len(votel.tasks) == 2


async def test_two_agents_get_two_cards(votel):
    await sync_agent(_cfg(votel), _card())
    await sync_agent(
        _cfg(votel), _card(agent_id="aaaaaaaa-0000-4000-8000-000000000001", name="Dental")
    )
    assert sorted(t["title"] for t in votel.tasks) == ["Dental", "Front Desk"]


async def test_an_existing_template_is_reused(votel):
    votel.templates[TEMPLATE] = str(uuid.uuid4())
    await sync_agent(_cfg(votel), _card())
    assert "create_status_template" not in [n for n, _ in votel.calls]
