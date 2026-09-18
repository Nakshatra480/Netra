"""Model providers available to the investigation engine."""

from __future__ import annotations

from .agentrouter import AgentRouterProvider
from .base import Completion, Message, ModelProvider, ModelUnavailable, ProviderUsage

__all__ = [
    "AgentRouterProvider",
    "Completion",
    "Message",
    "ModelProvider",
    "ModelUnavailable",
    "ProviderUsage",
    "build_provider",
]


def build_provider(config) -> ModelProvider:  # noqa: ANN001 - InvestigatorConfig
    """Construct the configured provider.

    Selection is configuration, not code: adding a provider means adding a
    branch here and an implementation, with nothing else in the engine aware of
    which one is in use.
    """
    if config.ai_provider == "agentrouter":
        return AgentRouterProvider(
            api_key=config.agentrouter_api_key,
            base_url=config.agentrouter_base_url,
            model=config.ai_model,
            route_key=config.agentrouter_route_key,
        )
    raise ModelUnavailable(f"Unknown AI provider: {config.ai_provider!r}")
