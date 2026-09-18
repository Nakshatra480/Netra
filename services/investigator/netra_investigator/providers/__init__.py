"""Model providers and the router that chooses between them."""

from __future__ import annotations

from .base import (
    Completion,
    InvocationRecord,
    Message,
    ModelExhausted,
    ModelProvider,
    ModelRequest,
    ModelUnavailable,
    ProviderUsage,
    Tier,
)
from .keypool import KeyPool, KeyState
from .ollama import OllamaProvider
from .openrouter import OpenRouterProvider, model_label
from .router import Budget, ModelRouter, RoutingOutcome

__all__ = [
    "Budget",
    "Completion",
    "InvocationRecord",
    "KeyPool",
    "KeyState",
    "Message",
    "ModelExhausted",
    "ModelProvider",
    "ModelRequest",
    "ModelRouter",
    "ModelUnavailable",
    "OllamaProvider",
    "OpenRouterProvider",
    "ProviderUsage",
    "RoutingOutcome",
    "Tier",
    "build_router",
    "model_label",
]


def build_router(config) -> ModelRouter:  # noqa: ANN001 - InvestigatorConfig
    """Construct the router from configuration.

    Both providers are optional. A deployment with no credentials and no local
    runtime produces a router that reports itself unavailable, which is a
    supported state: deterministic analysis does not need a model.
    """
    remote = (
        OpenRouterProvider(
            key_pool=KeyPool.from_secrets(list(config.openrouter_api_keys)),
            models_by_tier={t: list(m) for t, m in config.models_by_tier.items()},
            base_url=config.openrouter_base_url,
        )
        if config.remote_configured
        else None
    )

    local = (
        OllamaProvider(
            base_url=config.ollama_base_url,
            preferred_model=config.ollama_model,
        )
        if config.ollama_enabled
        else None
    )

    return ModelRouter(
        remote=remote,
        local=local,
        budget=Budget(
            max_turns=config.max_model_turns,
            max_input_tokens=config.max_input_tokens,
            max_output_tokens=config.max_output_tokens,
            max_total_tokens=config.max_investigation_tokens,
            max_cost_usd=config.max_cost_usd,
        ),
    )
