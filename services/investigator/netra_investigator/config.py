"""Configuration, validated once at startup.

Configuration is read from the environment and never from source. Secrets
arrive from AWS Secrets Manager in production and from the environment in local
development; they are never logged, never persisted, and never sent anywhere
except the provider that needs them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .providers.base import Tier

#: Server-side model allowlist, strongest first within each tier.
#:
#: A model name can never come from user input or from a model: it comes from
#: here. Paid Claude models are listed first because they are the strongest
#: option when an account has credits; the free-tier models below them are
#: capable enough to investigate a repository and keep Netra working on an
#: account with no credits.
DEFAULT_MODELS_BY_TIER: dict[Tier, list[str]] = {
    Tier.DEEP: [
        "anthropic/claude-opus-4.5",
        "anthropic/claude-sonnet-4.5",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "deepseek/deepseek-v4-flash-0731:free",
    ],
    Tier.STANDARD: [
        "anthropic/claude-sonnet-4.5",
        "deepseek/deepseek-v4-flash-0731:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "z-ai/glm-5.2:free",
    ],
    Tier.FAST: [
        "anthropic/claude-haiku-4.5",
        "deepseek/deepseek-v4-flash-0731:free",
        "z-ai/glm-5.2:free",
    ],
}


@dataclass(frozen=True, slots=True)
class InvestigatorConfig:
    # -- model providers (external to AWS) --
    #: Secret. Never logged, never in an event, never returned by an API.
    openrouter_api_keys: tuple[str, ...] = field(repr=False, default=())
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    models_by_tier: dict[Tier, list[str]] = field(
        default_factory=lambda: {k: list(v) for k, v in DEFAULT_MODELS_BY_TIER.items()}
    )

    ollama_enabled: bool = True
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str | None = None

    # -- budgets --
    max_model_turns: int = 4
    max_input_tokens: int = 60_000
    max_output_tokens: int = 1500
    max_investigation_tokens: int = 80_000
    max_cost_usd: float = 0.25
    max_fragment_tokens: int = 4_000

    # -- sandbox --
    sandbox_image: str = "netra-sandbox:latest"
    sandbox_timeout_s: float = 120.0
    sandbox_memory_mb: int = 512

    # -- AWS --
    aws_region: str = "eu-north-1"

    @property
    def remote_configured(self) -> bool:
        return bool(self.openrouter_api_keys)

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> InvestigatorConfig:
        source = env if env is not None else dict(os.environ)

        models = dict(DEFAULT_MODELS_BY_TIER)
        for tier, name in (
            (Tier.DEEP, "OPENROUTER_MODELS_DEEP"),
            (Tier.STANDARD, "OPENROUTER_MODELS_STANDARD"),
            (Tier.FAST, "OPENROUTER_MODELS_FAST"),
        ):
            override = _list(source.get(name))
            if override:
                models[tier] = override

        return cls(
            openrouter_api_keys=tuple(_list(source.get("OPENROUTER_API_KEYS"))),
            openrouter_base_url=source.get(
                "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
            ),
            models_by_tier={k: list(v) for k, v in models.items()},
            ollama_enabled=source.get("OLLAMA_ENABLED", "true").lower() != "false",
            ollama_base_url=source.get("OLLAMA_BASE_URL", "http://localhost:11434"),
            ollama_model=source.get("OLLAMA_MODEL") or None,
            max_model_turns=int(_number(source, "MAX_MODEL_TURNS", 4)),
            max_input_tokens=int(_number(source, "MAX_INPUT_TOKENS", 60_000)),
            max_output_tokens=int(_number(source, "MAX_OUTPUT_TOKENS", 1500)),
            max_investigation_tokens=int(
                _number(source, "MAX_INVESTIGATION_TOKENS", 80_000)
            ),
            max_cost_usd=_number(source, "MAX_INVESTIGATION_COST_USD", 0.25),
            max_fragment_tokens=int(_number(source, "MAX_FRAGMENT_TOKENS", 4_000)),
            sandbox_image=source.get("NETRA_SANDBOX_IMAGE", "netra-sandbox:latest"),
            sandbox_timeout_s=_number(source, "NETRA_SANDBOX_TIMEOUT_MS", 120_000) / 1000,
            sandbox_memory_mb=int(_number(source, "NETRA_SANDBOX_MEMORY_MB", 512)),
            aws_region=source.get("AWS_REGION", "eu-north-1"),
        )


def _list(raw: str | None) -> list[str]:
    """Parse a comma- or newline-separated configuration list."""
    if not raw:
        return []
    parts = [p.strip() for p in raw.replace("\n", ",").split(",")]
    return [p for p in parts if p]


def _number(source: dict[str, str], name: str, default: float) -> float:
    raw = source.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError as err:
        raise ValueError(f"{name} must be a number, got {raw!r}") from err


__all__ = ["DEFAULT_MODELS_BY_TIER", "InvestigatorConfig"]
