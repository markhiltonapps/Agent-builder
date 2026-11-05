"""The work after a call or chat ends, kept in the database until it is done.

When a call ends the worker first writes a job row (the record of the call plus the agent's settings),
which takes a moment, and then does the work: save the call, summarize it, send it to Votel. If that
all works the job is marked done. If anything fails, or the worker is stopped in the middle, the
row stays and is picked up again later by the builder API, which looks for due jobs every half
minute. So a Votel outage of an hour, or a worker that dies seconds after a call, loses nothing.

Retries back off (30 seconds, 2 minutes, 10 minutes, then longer) and give up after eight tries; a
job that gives up stays visible in ``finish_jobs`` with its last error. If the database itself
cannot be reached when the job is written, the work is done directly once, as it always was.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import aiohttp

from . import supabase
from .call_finish import after_call, process_call
from .config import AgentConfig
from .loader import LoadedConfig

log = logging.getLogger("agent_builder.finish_queue")

BACKOFF_S = (30, 120, 600, 1800, 3600, 10800, 21600, 43200)
MAX_ATTEMPTS = len(BACKOFF_S)
INLINE_LEASE_S = 300
"""While one process works on a job it holds it this long; after that another may take over."""
DRAIN_EVERY_S = 30.0


@dataclass
class Job:
    id: str
    loaded: LoadedConfig
    record: dict[str, Any]
    attempts: int = 0


class JobStore(Protocol):
    async def enqueue(self, loaded: LoadedConfig, record: dict[str, Any]) -> Job | None:
        """Write the job, already leased to the caller. None if this call was already queued."""

    async def claim(self, limit: int) -> list[Job]: ...
    async def done(self, job_id: str) -> None: ...
    async def retry(self, job_id: str, attempts: int, delay_s: float, error: str) -> None: ...
    async def fail(self, job_id: str, attempts: int, error: str) -> None: ...


def dedupe_key(record: dict[str, Any]) -> str:
    return f"{record['room']}:{record['started_at']}"


@dataclass
class MemoryJobStore:
    """For tests: the same behaviour as the table, without a database."""

    jobs: dict[str, dict[str, Any]] = field(default_factory=dict)
    clock: Any = lambda: datetime.now(UTC)

    async def enqueue(self, loaded: LoadedConfig, record: dict[str, Any]) -> Job | None:
        key = dedupe_key(record)
        if any(j["key"] == key for j in self.jobs.values()):
            return None
        job_id = f"job{len(self.jobs) + 1}"
        self.jobs[job_id] = {
            "key": key,
            "loaded": loaded,
            "record": record,
            "attempts": 0,
            "state": "pending",
            "run_after": self.clock(),
            "lease": self.clock() + timedelta(seconds=INLINE_LEASE_S),
            "error": None,
        }
        return Job(job_id, loaded, record, 0)

    async def claim(self, limit: int) -> list[Job]:
        now = self.clock()
        out = []
        for job_id, j in self.jobs.items():
            if len(out) >= limit:
                break
            if (
                j["state"] == "pending"
                and j["run_after"] <= now
                and (j["lease"] is None or j["lease"] < now)
            ):
                j["lease"] = now + timedelta(seconds=INLINE_LEASE_S)
                out.append(Job(job_id, j["loaded"], j["record"], j["attempts"]))
        return out

    async def done(self, job_id: str) -> None:
        self.jobs[job_id].update(state="done", lease=None)

    async def retry(self, job_id: str, attempts: int, delay_s: float, error: str) -> None:
        self.jobs[job_id].update(
            attempts=attempts,
            run_after=self.clock() + timedelta(seconds=delay_s),
            lease=None,
            error=error,
        )

    async def fail(self, job_id: str, attempts: int, error: str) -> None:
        self.jobs[job_id].update(state="failed", attempts=attempts, lease=None, error=error)


class SupabaseJobStore:
    """Rows in ``public.finish_jobs`` (the secret key only)."""

    def __init__(self, url: str, key: str, *, timeout_s: float = 8.0) -> None:
        self._base = f"{url.rstrip('/')}/rest/v1"
        self._headers = supabase.headers(key)
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)

    async def enqueue(self, loaded: LoadedConfig, record: dict[str, Any]) -> Job | None:
        row = {
            "dedupe_key": dedupe_key(record),
            "agent_id": loaded.agent_id,
            "account_id": loaded.account_id,
            "version_id": loaded.version_id,
            "version": loaded.version,
            "config": loaded.config.model_dump(mode="json"),
            "record": record,
            "lease_until": (datetime.now(UTC) + timedelta(seconds=INLINE_LEASE_S)).isoformat(),
        }
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.post(
                f"{self._base}/finish_jobs",
                params={"on_conflict": "dedupe_key"},
                data=json.dumps(row, default=str),
                headers={
                    **self._headers,
                    "Prefer": "resolution=ignore-duplicates,return=representation",
                },
            ) as r,
        ):
            r.raise_for_status()
            rows = await r.json()
        return _job(rows[0]) if rows else None

    async def claim(self, limit: int) -> list[Job]:
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.post(
                f"{self._base}/rpc/claim_finish_jobs",
                json={"p_limit": limit, "p_lease_s": INLINE_LEASE_S},
                headers=self._headers,
            ) as r,
        ):
            r.raise_for_status()
            rows = await r.json()
        return [_job(row) for row in rows]

    async def _patch(self, job_id: str, body: dict[str, Any]) -> None:
        async with (
            aiohttp.ClientSession(timeout=self._timeout) as http,
            http.patch(
                f"{self._base}/finish_jobs",
                params={"id": f"eq.{job_id}"},
                data=json.dumps(body, default=str),
                headers={**self._headers, "Prefer": "return=minimal"},
            ) as r,
        ):
            r.raise_for_status()

    async def done(self, job_id: str) -> None:
        # The call itself is saved under Calls; the copy of the conversation here is no longer needed.
        await self._patch(
            job_id,
            {
                "state": "done",
                "done_at": datetime.now(UTC).isoformat(),
                "lease_until": None,
                "record": {},
                "config": {},
                "last_error": None,
            },
        )

    async def retry(self, job_id: str, attempts: int, delay_s: float, error: str) -> None:
        await self._patch(
            job_id,
            {
                "attempts": attempts,
                "run_after": (datetime.now(UTC) + timedelta(seconds=delay_s)).isoformat(),
                "lease_until": None,
                "last_error": error[:300],
            },
        )

    async def fail(self, job_id: str, attempts: int, error: str) -> None:
        await self._patch(
            job_id,
            {
                "state": "failed",
                "attempts": attempts,
                "lease_until": None,
                "last_error": error[:300],
            },
        )


def _job(row: dict[str, Any]) -> Job:
    loaded = LoadedConfig(
        config=AgentConfig.model_validate(row["config"]),
        source="published",
        agent_id=row["agent_id"],
        account_id=row.get("account_id"),
        version_id=row.get("version_id"),
        version=row.get("version"),
    )
    return Job(str(row["id"]), loaded, dict(row["record"]), int(row.get("attempts") or 0))


def default_store() -> JobStore | None:
    creds = supabase.credentials()
    return SupabaseJobStore(*creds) if creds else None


async def run_job(store: JobStore, job: Job) -> bool:
    """Do one job's work and record the outcome. True if it is finished. Never raises."""
    error = await process_call(job.loaded, job.record, attempt=job.attempts)
    try:
        if error is None:
            await store.done(job.id)
            return True
        attempts = job.attempts + 1
        if attempts >= MAX_ATTEMPTS:
            log.error("giving up on finishing a call after %s tries: %s", attempts, error)
            await store.fail(job.id, attempts, error)
        else:
            delay = BACKOFF_S[attempts - 1]
            log.warning("will try again in %ss to finish a call: %s", delay, error)
            await store.retry(job.id, attempts, delay, error)
    except Exception:
        # The lease runs out and the job comes back; every step can safely run again.
        log.exception("could not record the outcome of a finish job")
    return False


async def finish_call(
    loaded: LoadedConfig, record: dict[str, Any], *, store: JobStore | None = None
) -> None:
    """Everything after a call or chat: queue it, then do it now. Never raises."""
    if not loaded.agent_id or not loaded.account_id:
        await after_call(loaded, record)  # a file-based agent: nothing to save or retry
        return
    store = store or default_store()
    if store is None:
        await after_call(loaded, record)
        return
    try:
        job = await store.enqueue(loaded, record)
    except Exception:
        log.exception("could not queue the finishing work; doing it directly")
        await after_call(loaded, record)
        return
    if job is None:
        log.info("this call was already queued")
        return
    await run_job(store, job)


async def drain(store: JobStore, limit: int = 5) -> int:
    """Work through due jobs (new, or left behind by a crash or a failure). Returns how many finished."""
    finished = 0
    for job in await store.claim(limit):
        if await run_job(store, job):
            finished += 1
    return finished


async def drain_forever(store: JobStore, every_s: float = DRAIN_EVERY_S) -> None:
    while True:
        try:
            await drain(store)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("looking for unfinished calls failed")
        await asyncio.sleep(every_s)
