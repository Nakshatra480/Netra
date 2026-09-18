"""The model provider boundary.

The investigation engine depends on this interface, never on a vendor. It asks
for an investigation; which provider, which key and which model served it is
decided by the router and reported back as provenance.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal, Protocol, runtime_checkable

Role = Literal["user", "assistant"]


class Tier(StrEnum):
    """How much capability a task deserves.

    Tiering exists so the strongest model is spent on the hardest reasoning
    rather than on every call.
    """

    #: Lightweight interpretation: short, well-bounded tasks.
    FAST = "FAST"
    #: Normal investigation.
    STANDARD = "STANDARD"
    #: Complex blast-radius or security reasoning.
    DEEP = "DEEP"


@dataclass(frozen=True, slots=True)
class Message:
    role: Role
    content: str


@dataclass(frozen=True, slots=True)
class ModelRequest:
    system: str
    messages: tuple[Message, ...]
    max_tokens: int
    tier: Tier = Tier.STANDARD
    temperature: float | None = 0.0


@dataclass(frozen=True, slots=True)
class Completion:
    """What a provider returned, plus what it cost."""

    text: str
    model: str
    provider: str
    stop_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    #: Monetary cost when the provider reports one, in USD.
    cost_usd: float | None = None
    latency_ms: int | None = None

    @property
    def total_tokens(self) -> int:
        return (self.input_tokens or 0) + (self.output_tokens or 0)


class ModelUnavailable(RuntimeError):
    """The model could not be reached, or refused the request.

    The message is always safe to show a user: it never contains credentials,
    headers or request bodies.
    """


class ModelExhausted(ModelUnavailable):
    """This provider has no remaining authorized capacity.

    Distinct from a transient failure: retrying will not help, and the router
    must move on rather than wait.
    """


@runtime_checkable
class ModelProvider(Protocol):
    """A text-completion provider.

    Deliberately minimal. Netra drives tool use through its own validated JSON
    protocol rather than a provider-native tool API, so every provider -- remote
    gateway or local runtime -- runs the same investigation under the same
    security boundary.
    """

    @property
    def name(self) -> str:
        """Display name, e.g. "OpenRouter". Shown in the UI, never a secret."""

    def available(self) -> bool:
        """Whether this provider can serve a request right now."""

    def generate(self, request: ModelRequest) -> Completion:
        """Produce a completion, or raise `ModelUnavailable`."""


@dataclass(slots=True)
class InvocationRecord:
    """One model call, for usage accounting. Never holds a credential."""

    provider: str
    model: str
    tier: str
    success: bool
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    #: Why this call happened on this provider rather than the preferred one.
    fallback_reason: str | None = None
    error: str | None = None


@dataclass(slots=True)
class ProviderUsage:
    """Running totals for one investigation, so cost is never a surprise."""

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    invocations: list[InvocationRecord] = field(default_factory=list)

    def record(self, record: InvocationRecord) -> None:
        self.calls += 1
        self.input_tokens += record.input_tokens
        self.output_tokens += record.output_tokens
        self.cost_usd += record.cost_usd
        self.invocations.append(record)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def to_metadata(self) -> dict[str, object]:
        """Safe aggregate usage for persistence and the admin view."""
        return {
            "calls": self.calls,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.total_tokens,
            "costUsd": round(self.cost_usd, 6),
        }


__all__ = [
    "Completion",
    "InvocationRecord",
    "Message",
    "ModelExhausted",
    "ModelProvider",
    "ModelRequest",
    "ModelUnavailable",
    "ProviderUsage",
    "Role",
    "Tier",
]
