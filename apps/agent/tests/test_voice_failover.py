"""Which voice a call uses, and how it moves to a backup when the primary fails."""

import pytest

from agent_builder import voice_failover as vf
from agent_builder.compiler import compile_agent
from agent_builder.config import AgentConfig, ModelSpec
from agent_builder.loader import DEFAULT_CONFIG, load_file
from agent_builder.providers import build_voice_model

OPENAI = ModelSpec()
GEMINI = ModelSpec(provider="google")
KEY = {"GEMINI_API_KEY": "g-test-key"}


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def cfg_with(**runtime) -> AgentConfig:
    raw = load_file(DEFAULT_CONFIG).model_dump(mode="json")
    raw["runtime"] = {**raw.get("runtime", {}), **runtime}
    return AgentConfig.model_validate(raw)


def test_a_gemini_spec_gets_its_own_model_and_voice():
    assert (GEMINI.model, GEMINI.voice) == ("gemini-3.1-flash-live-preview", "Puck")
    chosen = ModelSpec.model_validate({"provider": "google", "model": "gemini-x", "voice": "Kore"})
    assert (chosen.model, chosen.voice) == ("gemini-x", "Kore")
    assert OPENAI.model == "gpt-live-1"  # OpenAI defaults are untouched


def test_with_no_gemini_key_nothing_changes():
    assert vf.effective_models(cfg_with(), {}) == [OPENAI]


def test_a_gemini_key_adds_gemini_as_the_automatic_backup():
    models = vf.effective_models(cfg_with(), KEY)
    assert [m.provider for m in models] == ["openai", "google"]


def test_prefer_google_puts_the_backup_first_at_once():
    models = vf.effective_models(cfg_with(), {**KEY, "VOICE_PREFER": "google"})
    assert [m.provider for m in models] == ["google", "openai"]
    assert [
        m.provider for m in vf.effective_models(cfg_with(), {**KEY, "VOICE_PREFER": "openai"})
    ] == ["openai", "google"]
    assert vf.effective_models(cfg_with(), {"VOICE_PREFER": "google"}) == [
        OPENAI
    ]  # no key: ignored


def test_the_backup_can_be_switched_off():
    assert vf.effective_models(cfg_with(), {**KEY, "VOICE_FAILOVER": "off"}) == [OPENAI]


def test_an_agent_that_names_its_own_backups_is_not_second_guessed():
    own = cfg_with(fallbacks=[{"provider": "openai", "model": "gpt-live-1", "voice": "cedar"}])
    models = vf.effective_models(own, KEY)
    assert [m.voice for m in models] == ["marin", "cedar"]


def test_a_backup_without_its_key_is_skipped_never_tried():
    cfg = cfg_with(fallbacks=[{"provider": "google"}])
    assert vf.effective_models(cfg, {}) == [OPENAI]


def test_an_agent_already_on_gemini_gets_no_extra_backup():
    cfg = cfg_with(voice={"provider": "google"})
    assert [m.provider for m in vf.effective_models(cfg, KEY)] == ["google"]


def test_three_failures_in_two_minutes_mark_a_provider_down_then_it_gets_a_retry():
    clock = Clock()
    h = vf.Health(clock)
    key = vf.model_key(OPENAI)
    h.failure(key)
    h.failure(key)
    assert not h.is_open(key)
    h.failure(key)
    assert h.is_open(key)
    clock.now += vf.COOLDOWN_S + 1
    assert not h.is_open(key)  # one attempt is allowed through
    assert h.is_open(key)  # and the breaker is armed again until it succeeds
    h.success(key)
    assert not h.is_open(key)


def test_old_failures_are_forgotten():
    clock = Clock()
    h = vf.Health(clock)
    key = vf.model_key(OPENAI)
    h.failure(key)
    h.failure(key)
    clock.now += vf.WINDOW_S + 5
    h.failure(key)
    assert not h.is_open(key)


def test_a_call_starts_on_the_first_provider_not_marked_down():
    clock = Clock()
    h = vf.Health(clock)
    models = [OPENAI, GEMINI]
    assert vf.pick_start(models, h) == 0
    for _ in range(3):
        h.failure(vf.model_key(OPENAI))
    assert vf.pick_start(models, h) == 1
    for _ in range(3):
        h.failure(vf.model_key(GEMINI))
    assert vf.pick_start(models, h) == 0  # everything looks down: still try the primary


def test_a_failing_call_moves_to_the_next_model_and_a_lone_model_is_just_retried():
    h = vf.Health(Clock())
    assert vf.next_after_failure([OPENAI, GEMINI], 0, h) == 1
    assert vf.next_after_failure([OPENAI, GEMINI], 1, h) == 0
    assert vf.next_after_failure([OPENAI], 0, h) == 0
    third = ModelSpec(provider="openai", voice="cedar")
    for _ in range(3):
        h.failure(vf.model_key(GEMINI))
    assert vf.next_after_failure([OPENAI, GEMINI, third], 0, h) == 2  # skips the one that is down


def test_gemini_does_its_own_tool_work_so_it_gets_the_backend_flows_too():
    compiled = compile_agent(load_file(DEFAULT_CONFIG))
    assert compiled.voice_instructions in compiled.combined_instructions
    assert "# Backend flows" in compiled.combined_instructions
    assert "# Tool use" in compiled.combined_instructions
    assert "# Backend flows" not in compiled.voice_instructions


def test_the_gemini_model_is_built_only_with_a_key(monkeypatch):
    compiled = compile_agent(load_file(DEFAULT_CONFIG))
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        build_voice_model(GEMINI, compiled)
    monkeypatch.setenv("GEMINI_API_KEY", "g-test-key")
    model = build_voice_model(GEMINI, compiled)
    assert model.model == "gemini-3.1-flash-live-preview"


class FakeSession:
    def __init__(self):
        self.replies: list[str] = []
        self.handlers: dict[str, list] = {}

    def generate_reply(self, *, instructions: str):
        self.replies.append(instructions)

    def on(self, event: str, cb):
        self.handlers.setdefault(event, []).append(cb)

    def fire(self, event: str, state: str | None = None):
        from types import SimpleNamespace

        ev = SimpleNamespace(new_state=state) if state else SimpleNamespace()
        for cb in self.handlers.get(event, []):
            cb(ev)


@pytest.fixture
def greeting(monkeypatch):
    from agent_builder import worker

    monkeypatch.setattr(worker, "GREETING_RETRY_S", 0.05)
    fake = FakeSession()
    monkeypatch.setattr(worker.BuilderAgent, "session", property(lambda self: fake))
    compiled = compile_agent(load_file(DEFAULT_CONFIG))
    return worker, fake, compiled


async def test_a_backup_voice_that_stays_silent_is_asked_for_its_greeting_again(greeting):
    import asyncio

    worker, fake, compiled = greeting
    agent = worker.BuilderAgent(compiled, [], single_model=True)
    await agent.on_enter()
    await asyncio.sleep(0.3)
    assert len(fake.replies) == 3  # the first ask and two retries, then it stops
    assert all(compiled.opening_line in r for r in fake.replies)


async def test_once_the_agent_has_spoken_the_greeting_is_not_repeated(greeting):
    import asyncio

    worker, fake, compiled = greeting
    agent = worker.BuilderAgent(compiled, [], single_model=True)
    await agent.on_enter()
    fake.fire("agent_state_changed", "listening")  # just getting ready: not a greeting
    await asyncio.sleep(0.07)
    assert len(fake.replies) == 2  # so it still asked again
    fake.fire("agent_state_changed", "speaking")
    await asyncio.sleep(0.25)
    assert len(fake.replies) == 2  # and stopped asking once it spoke


async def test_the_main_voice_greets_once_with_no_watchdog(greeting):
    import asyncio

    worker, fake, compiled = greeting
    agent = worker.BuilderAgent(compiled, [])
    await agent.on_enter()
    await asyncio.sleep(0.25)
    assert len(fake.replies) == 1 and fake.handlers == {}
