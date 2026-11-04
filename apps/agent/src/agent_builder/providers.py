"""The one place that turns a ModelSpec into a model client.

Swapping a model or provider is a config change, never a code change. Phase 2 adds Gemini
Live and a cascaded STT -> LLM (Claude) -> TTS path here, behind the same function.
"""

from __future__ import annotations

from livekit.agents import llm
from livekit.plugins.openai.realtime import GPTLiveModel, ResponsesDelegationOptions

from .compiler import CompiledAgent
from .config import ModelSpec


def build_voice_model(spec: ModelSpec, compiled: CompiledAgent) -> llm.DuplexModel:
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

    raise ValueError(f"unsupported provider {spec.provider!r}")
