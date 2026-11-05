"""The retry queue for work after a call: nothing is lost, nothing is sent twice."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from agent_builder import finish_queue
from agent_builder.config import AgentConfig
from agent_builder.finish_queue import MAX_ATTEMPTS, MemoryJobStore, drain, finish_call, run_job
from agent_builder.loader import LoadedConfig
from agent_builder.template_library import all_industries, build

AGENT = "9bef4c7c-5c02-46fa-b325-f491a06c9d0c"


def _loaded() -> LoadedConfig:
    cfg = AgentConfig.model_validate(build(all_industries()[0]))
    return LoadedConfig(cfg, "published", AGENT, "22222222-2222-2222-2222-222222222222", "v", 1)


def _record(room: str = "web-chat-abc") -> dict:
    return {"room": room, "started_at": 1000.0, "duration_s": 5.0, "transcript": {"items": []}}


class Clock:
    def __init__(self):
        self.now = datetime(2026, 11, 5, tzinfo=UTC)

    def __call__(self):
        return self.now

    def advance(self, seconds: float):
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def steps(monkeypatch):
    """Stand-in for the work itself; ``results`` is what each attempt returns (None = finished)."""

    st = SimpleNamespace(results=[], seen=[])

    async def process(loaded, record, *, attempt=0):
        st.seen.append(attempt)
        return st.results.pop(0) if st.results else None

    monkeypatch.setattr(finish_queue, "process_call", process)
    return st


@pytest.fixture
def store():
    return MemoryJobStore(clock=Clock())


async def test_work_that_succeeds_is_done_at_once(steps, store):
    await finish_call(_loaded(), _record(), store=store)
    assert steps.seen == [0]
    assert [j["state"] for j in store.jobs.values()] == ["done"]


async def test_the_same_call_is_never_queued_twice(steps, store):
    await finish_call(_loaded(), _record(), store=store)
    await finish_call(_loaded(), _record(), store=store)
    assert steps.seen == [0] and len(store.jobs) == 1


async def test_work_that_fails_waits_and_is_retried_with_a_longer_wait_each_time(steps, store):
    clock = store.clock
    steps.results = ["Votel: down", "Votel: down", None]
    await finish_call(_loaded(), _record(), store=store)
    (job,) = store.jobs.values()
    assert job["state"] == "pending" and job["attempts"] == 1 and job["error"] == "Votel: down"
    assert await drain(store) == 0  # not due yet: nothing happens
    clock.advance(31)
    assert await drain(store) == 0  # second try fails too
    assert job["attempts"] == 2
    clock.advance(60)
    assert await drain(store) == 0  # the wait is now two minutes
    clock.advance(61)
    assert await drain(store) == 1
    assert job["state"] == "done" and steps.seen == [0, 1, 2]


async def test_a_job_another_process_is_working_on_is_left_alone_until_its_lease_ends(steps, store):
    job = await store.enqueue(
        _loaded(), _record()
    )  # leased to "us", as when a worker has just queued it
    assert job is not None
    assert await store.claim(5) == []
    store.clock.advance(finish_queue.INLINE_LEASE_S + 1)  # the worker died
    (again,) = await store.claim(5)
    assert again.id == job.id
    await run_job(store, again)
    assert store.jobs[job.id]["state"] == "done"


async def test_it_gives_up_after_the_last_try_and_keeps_the_reason(steps, store):
    steps.results = ["no luck"] * MAX_ATTEMPTS
    await finish_call(_loaded(), _record(), store=store)
    for _ in range(MAX_ATTEMPTS):
        store.clock.advance(13 * 3600)
        await drain(store)
    (job,) = store.jobs.values()
    assert (
        job["state"] == "failed" and job["attempts"] == MAX_ATTEMPTS and job["error"] == "no luck"
    )
    store.clock.advance(99 * 3600)
    assert await store.claim(5) == []


async def test_when_the_queue_cannot_be_written_the_work_is_done_directly_once(monkeypatch, store):
    direct = []

    async def after(loaded, record):
        direct.append(record["room"])

    async def broken(loaded, record):
        raise OSError("db down")

    monkeypatch.setattr(finish_queue, "after_call", after)
    store.enqueue = broken  # type: ignore[method-assign]
    await finish_call(_loaded(), _record(), store=store)
    assert direct == ["web-chat-abc"]


async def test_an_agent_with_no_account_has_nothing_to_queue(monkeypatch, store):
    direct = []

    async def after(loaded, record):
        direct.append(1)

    monkeypatch.setattr(finish_queue, "after_call", after)
    no_account = LoadedConfig(_loaded().config, "file")
    await finish_call(no_account, _record(), store=store)
    assert direct == [1] and store.jobs == {}


async def test_a_failure_recording_the_outcome_never_raises(steps, store):
    async def broken(*_a):
        raise OSError("db down")

    store.done = broken  # type: ignore[method-assign]
    job = await store.enqueue(_loaded(), _record())
    assert await run_job(store, job) is False
