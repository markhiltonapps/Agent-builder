"""The agent config contract.

An agent version is one JSON document validated by ``AgentConfig``. Every field the web
editor will expose lives here, and the compiler turns it into prompts and tools the same
way every time. Keep bounds tight: the same limits protect the runtime and, later, the
customer-facing editor.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = 1

ToolName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{1,47}$")]
ShortText = Annotated[str, Field(min_length=1, max_length=200)]
LongText = Annotated[str, Field(max_length=8000)]

PLACEHOLDERS = {"business", "agent_name"}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Persona(_Strict):
    agent_name: ShortText
    business_name: ShortText
    business_description: Annotated[str, Field(max_length=1000)] = ""
    tone: Literal["warm", "professional", "upbeat", "calm"] = "warm"
    languages: list[Annotated[str, Field(pattern=r"^[a-z]{2}(-[A-Z]{2})?$")]] = Field(
        default_factory=lambda: ["en"], min_length=1, max_length=5
    )
    bot_disclosure: Annotated[str, Field(max_length=300)] = ""
    timezone: ShortText = "America/Chicago"
    """IANA zone the business runs in; the agent is told today's date in this zone."""

    @field_validator("timezone")
    @classmethod
    def _real_timezone(cls, v: str) -> str:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as e:
            raise ValueError(f"unknown timezone {v!r}") from e
        return v


class Greetings(_Strict):
    """Spoken lines. ``{business}`` and ``{agent_name}`` are filled in by the compiler."""

    opening: ShortText
    still_there: ShortText = "Are you still there?"
    goodbye: ShortText = "Thanks for calling {business}. Have a great day!"

    @field_validator("opening", "still_there", "goodbye")
    @classmethod
    def _known_placeholders(cls, v: str) -> str:
        unknown = set(re.findall(r"\{(\w+)\}", v)) - PLACEHOLDERS
        if unknown:
            raise ValueError(f"unknown placeholder(s): {', '.join(sorted(unknown))}")
        return v


class EscalationRule(_Strict):
    condition: ShortText
    action: Literal["transfer", "take_message", "end_call"] = "transfer"
    handoff_summary: Annotated[str, Field(max_length=300)] = (
        "Caller {reason}. Summarize what they need in one sentence."
    )


class ConversationPolicy(_Strict):
    """Neato-owned speaking rules. Raw text by design; customers never edit these."""

    speaking_rules: LongText = ""
    backend_flows: LongText = ""
    interruption: Literal["yield_immediately", "finish_sentence"] = "yield_immediately"
    backchannel: Literal["none", "light", "natural"] = "light"


class ParameterSpec(_Strict):
    type: Literal["string", "integer", "number", "boolean"]
    description: ShortText
    enum: list[str] | None = None
    required: bool = True


class ToolDefinition(_Strict):
    """A tool is data: what the model sees plus which adapter answers it."""

    name: ToolName
    description: Annotated[str, Field(min_length=10, max_length=1000)]
    parameters: dict[ToolName, ParameterSpec] = Field(default_factory=dict)
    adapter: ToolName
    """Name of an entry in ``AgentConfig.adapters`` that executes this tool."""
    goal: bool = False
    """A successful result from a goal tool marks the call as completed."""

    def json_schema(self) -> dict[str, Any]:
        props: dict[str, Any] = {}
        for pname, spec in self.parameters.items():
            prop: dict[str, Any] = {"type": spec.type, "description": spec.description}
            if spec.enum:
                prop["enum"] = spec.enum
            props[pname] = prop
        return {
            "type": "object",
            "properties": props,
            "required": [p for p, s in self.parameters.items() if s.required],
            "additionalProperties": False,
        }


class AdapterConfig(_Strict):
    kind: Literal["mock", "http", "disabled"]
    options: dict[str, Any] = Field(default_factory=dict)
    """Kind-specific settings. ``mock``: ``{"seed": {...}}``. ``http``: base URL, mappings."""


class ModelSpec(_Strict):
    """One voice model. No model id lives in code; it is always named here."""

    provider: Literal["openai", "azure"] = "openai"
    model: ShortText = "gpt-live-1"
    voice: ShortText = "marin"
    backend_model: ShortText | None = None
    """Responses model that runs delegated tool work. Provider default when unset."""
    azure_deployment: ShortText | None = None
    azure_backend_deployment: ShortText | None = None

    @model_validator(mode="after")
    def _azure_needs_deployments(self) -> ModelSpec:
        if self.provider == "azure" and not (
            self.azure_deployment and self.azure_backend_deployment
        ):
            raise ValueError("azure needs azure_deployment and azure_backend_deployment")
        return self


class RuntimeSettings(_Strict):
    voice: ModelSpec = Field(default_factory=ModelSpec)
    fallbacks: list[ModelSpec] = Field(default_factory=list, max_length=4)
    """Ordered backup voice models (Phase 2). Ignored until failover ships."""
    max_call_seconds: Annotated[int, Field(ge=60, le=3600)] = 900
    silence_timeout_seconds: Annotated[int, Field(ge=5, le=120)] = 15


class BookingLink(_Strict):
    """Let the agent send callers a link to book an appointment themselves (through Votel)."""

    url: Annotated[str, Field(max_length=300)]
    channel: Literal["sms", "email"] = "sms"

    @field_validator("url")
    @classmethod
    def _https(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith("https://") or len(v) < 12 or " " in v:
            raise ValueError("the booking link must be a web address starting with https://")
        return v


class AgentConfig(_Strict):
    schema_version: Literal[1] = SCHEMA_VERSION
    persona: Persona
    greetings: Greetings
    guardrails: list[ShortText] = Field(default_factory=list, max_length=30)
    escalation: list[EscalationRule] = Field(default_factory=list, max_length=20)
    policy: ConversationPolicy = Field(default_factory=ConversationPolicy)
    tools: list[ToolDefinition] = Field(default_factory=list, max_length=40)
    adapters: dict[ToolName, AdapterConfig] = Field(default_factory=dict)
    runtime: RuntimeSettings = Field(default_factory=RuntimeSettings)
    booking: BookingLink | None = None

    @model_validator(mode="after")
    def _tools_bind_to_known_adapters(self) -> AgentConfig:
        names = [t.name for t in self.tools]
        dupes = {n for n in names if names.count(n) > 1}
        if dupes:
            raise ValueError(f"duplicate tool name(s): {', '.join(sorted(dupes))}")
        reserved = {"end_call", "transfer_to_human", "take_message", "send_booking_link"} & set(
            names
        )
        if reserved:
            raise ValueError(f"reserved built-in tool name(s): {', '.join(sorted(reserved))}")
        missing = {t.adapter for t in self.tools} - set(self.adapters)
        if missing:
            raise ValueError(f"tools reference unknown adapter(s): {', '.join(sorted(missing))}")
        return self

    def enabled_tools(self) -> list[ToolDefinition]:
        return [t for t in self.tools if self.adapters[t.adapter].kind != "disabled"]
