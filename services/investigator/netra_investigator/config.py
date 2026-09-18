"""Configuration, validated once at startup.

Configuration is read from the environment and never from source. Secrets are
never logged, and no default here silently weakens a security control.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class InvestigatorConfig:
    aws_region: str
    bedrock_model_id: str
    sandbox_image: str
    sandbox_timeout_s: float
    sandbox_memory_mb: int
    #: Bound on agent turns, so one investigation cannot run up an unbounded bill.
    max_agent_iterations: int

    @classmethod
    def from_env(cls) -> InvestigatorConfig:
        return cls(
            aws_region=os.environ.get("AWS_REGION", "eu-north-1"),
            bedrock_model_id=os.environ.get(
                "BEDROCK_MODEL_ID", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"
            ),
            sandbox_image=os.environ.get("NETRA_SANDBOX_IMAGE", "netra-sandbox:latest"),
            sandbox_timeout_s=_float_env("NETRA_SANDBOX_TIMEOUT_MS", 120_000) / 1000,
            sandbox_memory_mb=int(_float_env("NETRA_SANDBOX_MEMORY_MB", 512)),
            max_agent_iterations=int(_float_env("NETRA_MAX_AGENT_ITERATIONS", 12)),
        )


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError as err:
        raise ValueError(f"{name} must be a number, got {raw!r}") from err


__all__ = ["InvestigatorConfig"]
