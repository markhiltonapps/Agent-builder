"""The one place that turns a ModelSpec into a model client.

Swapping a model or provider is a config change, never a code change. Phase 2 adds Gemini
Live and a cascaded STT -> LLM (Claude) -> TTS path here, behind the same function.
"""

from __future__ import annotations

import os

from livekit.agents import llm
from livekit.plugins import google
from livekit.plugins.openai.realtime import GPTLiveModel, ResponsesDelegationOptions

from .compiler import CompiledAgent
from .config import ModelSpec


def google_key() -> str | None:
    return (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip() or None


def build_voice_model(
    spec: ModelSpec, compiled: CompiledAgent
) -> llm.DuplexModel | llm.RealtimeModel:
    responses = ResponsesDelegationOptions(instructions=compiled.backend_instructions)

    if spec.provider == "openai":
        if spec.backend_model:
            responses["model"] = spec.backend_model
        return GPTLiveModel(model=spec.model, voice=spec.voice, responses_options=responses)

    if spec.provider == "azure":
        assert spec.azure_deployment and spec.azure_backend_deployment  # validated by ModelSpec
        responses["model"] = spec.azure_backend_deployment
        return GPTLiveModel.with_azure(
            azure_deployment=spec.azure_deployment,
            voice=spec.voice,
            responses_options=responses,
        )

    if spec.provider == "google":
        key = google_key()
        if key is None:
            raise ValueError("GEMINI_API_KEY is not set")
        # Gemini does its own tool work, so the agent gets the combined instructions (see worker).
        return google.realtime.RealtimeModel(model=spec.model, voice=spec.voice, api_key=key)

    raise ValueError(f"unsupported provider {spec.provider!r}")
