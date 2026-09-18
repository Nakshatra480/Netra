"""The model router.

The investigation engine asks for an investigation; the router decides how it
is served and reports back exactly what happened. It owns provider selection,
failover, budgets and usage accounting, so no other part of Netra needs to know
whether a completion came from a remote gateway or a local runtime.

The path is explicit, and the UI shows the one that actually ran:

    OpenRouter (authorized credentials, allowlisted model)
        -> rate limited or exhausted
    Ollama (capable local model)
        -> unavailable
    deterministic analysis only

There is no step that fabricates a response, and no step that loops.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .base import (
    Completion,
    InvocationRecord,
    ModelExhausted,
    ModelProvider,
    ModelRequest,
    ModelUnavailable,
    ProviderUsage,
    Tier,
)
from .ollama import OllamaProvider
from .openrouter import OpenRouterProvider, model_label

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class Budget:
    """Hard limits for a single investigation.

    Reaching a limit ends the model's participation, not the investigation:
    deterministic analysis still runs and still produces the verified finding.
    """

    max_turns: int = 4
    max_input_tokens: int = 60_000
    max_output_tokens: int = 1500
    max_total_tokens: int = 80_000
    max_cost_usd: float = 0.25

    def exceeded_by(self, usage: ProviderUsage) -> str | None:
        """The limit that has been reached, if any."""
        if usage.calls >= self.max_turns:
            return f"model turn limit ({self.max_turns})"
        if usage.total_tokens >= self.max_total_tokens:
            return f"token budget ({self.max_total_tokens:,} tokens)"
        if usage.cost_usd >= self.max_cost_usd:
            return f"cost budget (${self.max_cost_usd:.2f})"
        return None


@dataclass(slots=True)
class RoutingOutcome:
    """Which path served the request, for provenance and the UI."""

    provider: str | None = None
    model: str | None = None
    model_label: str | None = None
    #: Why a non-preferred path was used, when one was.
    fallback_reason: str | None = None
    #: Set when no model ran at all.
    unavailable_reason: str | None = None

    @property
    def model_used(self) -> bool:
        return self.provider is not None

    def describe(self) -> str:
        """The single line the UI shows. Never claims a run that did not happen."""
        if not self.model_used:
            return f"AI unavailable — {self.unavailable_reason or 'deterministic analysis'}"
        return f"{self.provider} · {self.model_label or self.model}"


class ModelRouter:
    """Selects a provider, applies budgets, and records what happened."""

    def __init__(
        self,
        *,
        remote: OpenRouterProvider | None,
        local: OllamaProvider | None,
        budget: Budget | None = None,
    ) -> None:
        self._remote = remote
        self._local = local
        self.budget = budget or Budget()
        self.usage = ProviderUsage()
        self.outcome = RoutingOutcome()

    @property
    def providers(self) -> list[ModelProvider]:
        return [p for p in (self._remote, self._local) if p is not None]

    def preflight(self) -> str | None:
        """Why no model can run, checked before any context is built.

        Called before the expensive work so an investigation with no available
        model skips straight to deterministic analysis rather than assembling a
        prompt it cannot send.
        """
        if self._remote is not None and self._remote.available():
            return None
        if self._local is not None and self._local.available():
            return None

        if self._remote is None and self._local is None:
            return "no model provider is configured"
        if self._remote is not None and not self._remote.available():
            remote_reason = (
                "no OpenRouter credentials are configured"
                if not self._remote.available() and not self._remote.health()
                else "all OpenRouter credentials are rate limited or exhausted"
            )
        else:
            remote_reason = "no remote provider is configured"
        local_reason = self._local.diagnosis() if self._local else "no local provider is configured"
        return f"{remote_reason}; {local_reason}"

    def generate(self, request: ModelRequest) -> Completion | None:
        """Serve one model call, or None when no path can.

        Returning None rather than raising is deliberate: an absent model is an
        expected state for Netra, not an error, and the caller continues with
        deterministic analysis.
        """
        limit = self.budget.exceeded_by(self.usage)
        if limit is not None:
            self.outcome.unavailable_reason = f"reached its {limit}"
            logger.info("model budget reached: %s", limit)
            return None

        bounded = ModelRequest(
            system=request.system,
            messages=request.messages,
            max_tokens=min(request.max_tokens, self.budget.max_output_tokens),
            tier=request.tier,
            temperature=request.temperature,
        )

        remote_failure: str | None = None

        if self._remote is not None and self._remote.available():
            try:
                completion = self._remote.generate(bounded)
                self._record(completion, request.tier, fallback_reason=None)
                return completion
            except ModelExhausted as err:
                remote_failure = str(err)
                logger.info("remote capacity unavailable: %s", err)
            except ModelUnavailable as err:
                remote_failure = str(err)
                logger.warning("remote provider failed: %s", err)
        elif self._remote is not None:
            remote_failure = "all OpenRouter credentials are rate limited or exhausted"

        if self._local is not None and self._local.available():
            reason = remote_failure or "no remote provider is configured"
            try:
                completion = self._local.generate(bounded)
                self._record(completion, request.tier, fallback_reason=reason)
                return completion
            except ModelUnavailable as err:
                logger.info("local fallback failed: %s", err)
                self.outcome.unavailable_reason = f"{reason}; {err}"
                self._record_failure(request.tier, str(err), reason)
                return None

        local_reason = self._local.diagnosis() if self._local else "no local fallback is configured"
        self.outcome.unavailable_reason = (
            f"{remote_failure}; {local_reason}" if remote_failure else local_reason
        )
        self._record_failure(request.tier, self.outcome.unavailable_reason, remote_failure)
        return None

    def _record(self, completion: Completion, tier: Tier, fallback_reason: str | None) -> None:
        self.usage.record(
            InvocationRecord(
                provider=completion.provider,
                model=completion.model,
                tier=str(tier),
                success=True,
                input_tokens=completion.input_tokens or 0,
                output_tokens=completion.output_tokens or 0,
                cost_usd=completion.cost_usd or 0.0,
                latency_ms=completion.latency_ms or 0,
                fallback_reason=fallback_reason,
            )
        )
        self.outcome = RoutingOutcome(
            provider=completion.provider,
            model=completion.model,
            model_label=model_label(completion.model),
            fallback_reason=fallback_reason,
        )

    def _record_failure(self, tier: Tier, error_text: str, fallback_reason: str | None) -> None:
        self.usage.invocations.append(
            InvocationRecord(
                provider="none",
                model="none",
                tier=str(tier),
                success=False,
                error=error_text,
                fallback_reason=fallback_reason,
            )
        )

    def metadata(self) -> dict[str, object]:
        """Provenance and usage for persistence and display. No credentials."""
        return {
            "provider": self.outcome.provider,
            "model": self.outcome.model,
            "modelLabel": self.outcome.model_label,
            "modelUsed": self.outcome.model_used,
            "fallbackReason": self.outcome.fallback_reason,
            "unavailableReason": self.outcome.unavailable_reason,
            "display": self.outcome.describe(),
            **self.usage.to_metadata(),
        }

    def health(self) -> dict[str, object]:
        """Safe aggregate provider health for the admin view."""
        return {
            "openRouter": {
                "configured": self._remote is not None,
                "available": bool(self._remote and self._remote.available()),
                "credentials": self._remote.health() if self._remote else [],
            },
            "ollama": {
                "configured": self._local is not None,
                "available": bool(self._local and self._local.available()),
                "diagnosis": self._local.diagnosis() if self._local else None,
            },
        }


__all__ = ["Budget", "ModelRouter", "RoutingOutcome"]
