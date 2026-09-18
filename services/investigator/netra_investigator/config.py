"""Configuration, validated once at startup.

Configuration is read from the environment and never from source. Secrets
arrive from AWS Secrets Manager in production and from the environment in local
development; they are never logged, never persisted, and never sent anywhere
except the provider that needs them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

#: Models Netra is willing to run. Sonnet is the default investigator; Opus is
#: available for deeper investigation where it is worth the cost.
SUPPORTED_MODELS = {
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
    "claude-haiku-4-5-20251001",
}

DEFAULT_MODEL = "claude-sonnet-4-5-20250929"


@dataclass(frozen=True, slots=True)
class InvestigatorConfig:
    # -- model gateway (external to AWS) --
    ai_provider: str
    ai_model: str
    agentrouter_base_url: str
    agentrouter_route_key: str
    #: Secret. Never logged, never included in an event, never returned by an API.
    agentrouter_api_key: str = field(repr=False, default="")

    # -- sandbox --
    sandbox_image: str = "netra-sandbox:latest"
    sandbox_timeout_s: float = 120.0
    sandbox_memory_mb: int = 512

    # -- bounds --
    #: Cap on agent turns, so one investigation cannot run up an unbounded bill.
    max_agent_iterations: int = 6
    max_output_tokens: int = 1200
    #: Hard ceiling on gateway spend for a single investigation, in the
    #: provider's own units. The agent stops when it is reached; the
    #: deterministic analysis still runs, so the investigation still concludes.
    #: AgentRouter bills per call against the requested max_tokens, so a turn
    #: costs roughly 8 credits (~$0.008) at the default output budget.
    max_cost_units: float = 60.0
    #: Bound on how much of a tool's output is fed back to the model. The
    #: conversation is resent every turn, so this is the main cost lever.
    max_tool_result_chars: int = 2500

    # -- AWS --
    aws_region: str = "eu-north-1"

    @property
    def model_configured(self) -> bool:
        return bool(self.agentrouter_api_key)

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> InvestigatorConfig:
        source = env if env is not None else dict(os.environ)

        model = source.get("AI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
        if model not in SUPPORTED_MODELS:
            # A typo must fail loudly at startup rather than mid-investigation.
            raise ValueError(
                f"AI_MODEL {model!r} is not supported. Choose one of: "
                f"{', '.join(sorted(SUPPORTED_MODELS))}"
            )

        return cls(
            ai_provider=source.get("AI_PROVIDER", "agentrouter").strip().lower(),
            ai_model=model,
            agentrouter_base_url=source.get(
                "AGENTIC_API_BASE_URL", "https://api.agentrouter.to/api/agentic-api"
            ),
            agentrouter_route_key=source.get(
                "AGENTROUTER_ROUTE_KEY", "models.chat.complete.anthropic.messages.mpp"
            ),
            agentrouter_api_key=source.get("AGENTIC_API_KEY", ""),
            sandbox_image=source.get("NETRA_SANDBOX_IMAGE", "netra-sandbox:latest"),
            sandbox_timeout_s=_number(source, "NETRA_SANDBOX_TIMEOUT_MS", 120_000) / 1000,
            sandbox_memory_mb=int(_number(source, "NETRA_SANDBOX_MEMORY_MB", 512)),
            max_agent_iterations=int(_number(source, "NETRA_MAX_AGENT_ITERATIONS", 6)),
            max_output_tokens=int(_number(source, "NETRA_MAX_OUTPUT_TOKENS", 1200)),
            max_cost_units=_number(source, "NETRA_MAX_COST_UNITS", 60),
            max_tool_result_chars=int(_number(source, "NETRA_MAX_TOOL_RESULT_CHARS", 2500)),
            aws_region=source.get("AWS_REGION", "eu-north-1"),
        )


def _number(source: dict[str, str], name: str, default: float) -> float:
    raw = source.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError as err:
        raise ValueError(f"{name} must be a number, got {raw!r}") from err


__all__ = ["DEFAULT_MODEL", "SUPPORTED_MODELS", "InvestigatorConfig"]
