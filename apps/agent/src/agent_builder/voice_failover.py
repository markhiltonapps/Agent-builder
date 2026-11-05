"""Which voice model a call uses, and what happens when it fails.

The primary voice is the agent's own (``runtime.voice``). Backups are ``runtime.fallbacks``, or,
when the agent names none, a Gemini Live backup that is added automatically whenever a Gemini key
is set on the server (turn it off with ``VOICE_FAILOVER=off``).

A small in-memory circuit breaker remembers which provider has been failing, so the next calls
start on the working one instead of each caller waiting through the same outage. A call that is
already going when its model fails is moved to the next one, with the conversation carried over
(the worker already saves every turn; see ``session_store``).
"""

from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from collections.abc import Callable

from .config import AgentConfig, ModelSpec

FAILURES_TO_OPEN = 3
WINDOW_S = 120.0
COOLDOWN_S = 60.0


def model_key(spec: ModelSpec) -> str:
    return f"{spec.provider}:{spec.model}"


def has_credentials(spec: ModelSpec, env: dict[str, str] | None = None) -> bool:
    """Is the key this model needs present? A backup without a key is skipped, never tried."""
    env = os.environ if env is None else env
    if spec.provider == "google":
        return bool((env.get("GEMINI_API_KEY") or env.get("GOOGLE_API_KEY") or "").strip())
    return True  # OpenAI and Azure keys are checked at startup (preflight)


def effective_models(cfg: AgentConfig, env: dict[str, str] | None = None) -> list[ModelSpec]:
    """The primary voice first, then its backups. Models whose key is missing are left out."""
    env = os.environ if env is None else env
    chain = [cfg.runtime.voice, *cfg.runtime.fallbacks]
    if (
        not cfg.runtime.fallbacks
        and cfg.runtime.voice.provider != "google"
        and env.get("VOICE_FAILOVER", "on").strip().lower() != "off"
    ):
        chain.append(ModelSpec(provider="google"))
    usable = [m for m in chain if has_credentials(m, env)]
    # A manual override for an emergency or a demo: VOICE_PREFER=google puts Gemini first right
    # away, without waiting for the automatic switch.
    prefer = env.get("VOICE_PREFER", "").strip().lower()
    if prefer:
        usable.sort(key=lambda m: m.provider != prefer)  # stable: the rest keep their order
    return usable or [cfg.runtime.voice]


class Health:
    """Per-process memory of recent failures. Cheap, and deliberately forgiving: it only ever
    reorders the choice, it never refuses to place a call."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._fails: dict[str, deque[float]] = defaultdict(deque)
        self._opened: dict[str, float] = {}

    def failure(self, key: str) -> None:
        now = self._clock()
        q = self._fails[key]
        q.append(now)
        while q and now - q[0] > WINDOW_S:
            q.popleft()
        if len(q) >= FAILURES_TO_OPEN:
            self._opened[key] = now

    def success(self, key: str) -> None:
        self._fails.pop(key, None)
        self._opened.pop(key, None)

    def is_open(self, key: str) -> bool:
        """True while a provider is considered down. After the cooldown one call may try it again."""
        opened = self._opened.get(key)
        if opened is None:
            return False
        if self._clock() - opened >= COOLDOWN_S:
            self._opened[key] = self._clock()  # half-open: let one attempt through, then re-arm
            return False
        return True


def pick_start(models: list[ModelSpec], health: Health) -> int:
    """The first model not currently considered down; the primary if all of them are."""
    for i, m in enumerate(models):
        if not health.is_open(model_key(m)):
            return i
    return 0


def next_after_failure(models: list[ModelSpec], current: int, health: Health) -> int:
    """Where to go when ``current`` fails: the next healthy model, else the next one in line.
    With a single model there is nowhere else to go, so it is simply tried again."""
    if len(models) == 1:
        return 0
    order = [(current + step) % len(models) for step in range(1, len(models))]
    for i in order:
        if not health.is_open(model_key(models[i])):
            return i
    return order[0]


health = Health()
