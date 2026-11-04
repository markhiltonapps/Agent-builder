import json

import pytest
from pydantic import ValidationError

from agent_builder.adapters.mock import MockAdapter
from agent_builder.compiler import compile_agent
from agent_builder.config import AgentConfig, ModelSpec
from agent_builder.loader import DEFAULT_CONFIG, load_config, load_file
from agent_builder.tools import CallRecorder, build_tools


@pytest.fixture
def cfg() -> AgentConfig:
    return load_file(DEFAULT_CONFIG)


def _raw(cfg: AgentConfig) -> dict:
    return cfg.model_dump(mode="json")


# --- config -------------------------------------------------------------------------------


def test_template_validates(cfg):
    assert cfg.persona.business_name == "Brightline Home Services"
    assert {t.name for t in cfg.tools if t.goal} == {"schedule_visit", "request_callback"}


def test_unknown_adapter_rejected(cfg):
    raw = _raw(cfg)
    raw["tools"][0]["adapter"] = "nope"
    with pytest.raises(ValidationError, match="unknown adapter"):
        AgentConfig.model_validate(raw)


def test_reserved_tool_name_rejected(cfg):
    raw = _raw(cfg)
    raw["tools"][0]["name"] = "transfer_to_human"
    with pytest.raises(ValidationError, match="reserved"):
        AgentConfig.model_validate(raw)


def test_unknown_placeholder_rejected(cfg):
    raw = _raw(cfg)
    raw["greetings"]["opening"] = "Hi from {company}"
    with pytest.raises(ValidationError, match="unknown placeholder"):
        AgentConfig.model_validate(raw)


def test_extra_fields_rejected(cfg):
    raw = _raw(cfg)
    raw["persona"]["favorite_color"] = "blue"
    with pytest.raises(ValidationError):
        AgentConfig.model_validate(raw)


def test_azure_requires_deployments():
    with pytest.raises(ValidationError, match="azure needs"):
        ModelSpec(provider="azure")


# --- compiler -----------------------------------------------------------------------------


def test_compiler_is_deterministic(cfg):
    a, b = compile_agent(cfg), compile_agent(AgentConfig.model_validate(_raw(cfg)))
    assert a == b


def test_compiler_fills_placeholders(cfg):
    c = compile_agent(cfg)
    assert c.opening_line.startswith("Thanks for calling Brightline Home Services, this is Riley")
    assert "{business}" not in c.voice_instructions
    assert "{agent_name}" not in c.voice_instructions


def test_compiler_includes_every_section(cfg):
    c = compile_agent(cfg)
    for heading in (
        "# Identity",
        "# Style",
        "# Speaking rules",
        "# Call flow",
        "# What you can do",
        "# Guardrails",
        "# Escalation",
    ):
        assert heading in c.voice_instructions
    assert "# Backend flows" in c.backend_instructions
    assert "Never collect payment card numbers" in c.backend_instructions


def test_fingerprint_tracks_changes(cfg):
    raw = _raw(cfg)
    raw["greetings"]["opening"] = "Hello, {business}!"
    assert (
        compile_agent(cfg).fingerprint != compile_agent(AgentConfig.model_validate(raw)).fingerprint
    )


def test_disabled_adapter_drops_tools(cfg):
    raw = _raw(cfg)
    raw["adapters"]["demo_data"]["kind"] = "disabled"
    c = compile_agent(AgentConfig.model_validate(raw))
    assert c.tools == ()
    assert "# What you can do" not in c.voice_instructions


# --- mock adapter -------------------------------------------------------------------------


async def test_mock_lookup_is_case_insensitive(cfg):
    a = MockAdapter("demo", cfg.adapters["demo_data"].options)
    hit = await a.call("get_quote", {"service_type": "HVAC "})
    assert hit["found"] and hit["record"]["typical_range"] == "$200 to $800"
    miss = await a.call("check_service_area", {"zip_code": "10001"})
    assert miss == {"found": False}


async def test_mock_list_filters_and_limits(cfg):
    a = MockAdapter("demo", cfg.adapters["demo_data"].options)
    r = await a.call("check_availability", {"date": "2026-11-05", "service_type": "plumbing"})
    assert r["count"] == 2 and all(s["service_type"] == "plumbing" for s in r["results"])
    r = await a.call("check_availability", {"date": "2026-11-05"})
    assert r["count"] == 4 and len(r["results"]) == 2


async def test_mock_state_is_per_instance(cfg):
    opts = cfg.adapters["demo_data"].options
    a, b = MockAdapter("demo", opts), MockAdapter("demo", opts)
    await a.call("request_callback", {"name": "Sam", "phone": "5125550100", "reason": "x"})
    assert len(a.state["callbacks"]) == 1
    assert "callbacks" not in b.state


# --- tools --------------------------------------------------------------------------------


async def test_tools_record_calls_and_goal(cfg):
    compiled = compile_agent(cfg)
    recorder = CallRecorder()
    tools, _ = build_tools(cfg, compiled, recorder)
    by_name = {t.info.name: t for t in tools}
    assert set(by_name) == {t.name for t in cfg.tools} | {"transfer_to_human", "take_message"}

    out = await by_name["check_service_area"](raw_arguments={"zip_code": "78704"}, context=None)
    assert json.loads(out)["found"] is True
    assert not recorder.goal_reached

    out = await by_name["schedule_visit"](
        raw_arguments={
            "name": "Sam Lee",
            "phone": "5125550100",
            "address": "1 Main St",
            "zip_code": "78704",
            "service_type": "plumbing",
            "date": "2026-11-05",
            "window": "8am to 11am",
            "problem": "leaking faucet",
        },
        context=None,
    )
    assert json.loads(out)["id"].startswith("BL-")
    assert recorder.goal_reached
    assert [c.tool for c in recorder.calls] == ["check_service_area", "schedule_visit"]


async def test_transfer_tool_records_reason(cfg):
    recorder = CallRecorder()
    tools, _ = build_tools(cfg, compile_agent(cfg), recorder)
    transfer = next(t for t in tools if t.info.name == "transfer_to_human")
    await transfer(raw_arguments={"reason": "gas smell"}, context=None)
    assert recorder.transferred and recorder.transfer_reason == "gas smell"


def test_tool_schema_marks_optional_params(cfg):
    avail = next(t for t in cfg.tools if t.name == "check_availability")
    schema = avail.json_schema()
    assert schema["required"] == ["date"]
    assert schema["properties"]["service_type"]["enum"] == ["plumbing", "hvac", "electrical"]


# --- loader + providers -------------------------------------------------------------------


def test_loader_accepts_inline_config(cfg):
    inline = load_config(json.dumps({"config": _raw(cfg)}))
    assert inline == cfg
    assert load_config(None) == cfg


def test_provider_builds_gpt_live(cfg, monkeypatch):
    from agent_builder.providers import build_voice_model

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    model = build_voice_model(cfg.runtime.voice, compile_agent(cfg))
    assert model.model == "gpt-live-1"
    assert model.provider == "api.openai.com"


def test_worker_imports():
    from agent_builder import worker

    assert worker.server is not None


def test_today_is_added_but_not_fingerprinted(cfg):
    from datetime import UTC, datetime

    plain = compile_agent(cfg)
    dated = compile_agent(cfg, now=datetime(2026, 11, 4, 18, 30, tzinfo=UTC))
    assert "Wednesday, November 4, 2026 (2026-11-04), 12:30 PM" in dated.voice_instructions
    assert "2026-11-04" in dated.backend_instructions
    assert "# Today" not in plain.voice_instructions
    assert plain.fingerprint == dated.fingerprint


def test_bad_timezone_rejected(cfg):
    raw = _raw(cfg)
    raw["persona"]["timezone"] = "Mars/Olympus"
    with pytest.raises(ValidationError, match="unknown timezone"):
        AgentConfig.model_validate(raw)


async def test_take_message_is_recorded_on_the_call_and_drops_empty_fields(cfg):
    recorder = CallRecorder()
    tools, _ = build_tools(cfg, compile_agent(cfg), recorder)
    message = next(t for t in tools if t.info.name == "take_message")
    out = await message(
        raw_arguments={
            "name": " Sam Lee ",
            "phone": "5125550100",
            "reason": "Leaking faucet",
            "best_time": " ",
        },
        context=None,
    )
    assert json.loads(out)["status"] == "recorded"
    (call,) = recorder.calls
    assert (call.tool, call.ok, call.goal) == ("take_message", True, False)
    assert call.args == {"name": "Sam Lee", "phone": "5125550100", "reason": "Leaking faucet"}
