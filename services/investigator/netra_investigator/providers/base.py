"""The model provider boundary.

The investigation engine depends on this interface, never on a specific
vendor. Swapping the model gateway is a configuration change plus one new
implementation of `ModelProvider`; nothing in the pipeline, the analyzers or
the tools changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

Role = Literal["user", "assistant"]


@dataclass(frozen=True, slots=True)
class Message:
    role: Role
    content: str


@dataclass(frozen=True, slots=True)
class Completion:
    """What a provider returned, plus what it cost."""

    text: str
    model: str
    provider: str
    stop_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    #: Provider-specific usage unit, recorded so cost stays visible.
    cost_units: float | None = None
    cost_unit_name: str | None = None


class ModelUnavailable(RuntimeError):
    """The model could not be reached, or refused the request.

    Raised with a message that is safe to show a user: it never contains
    credentials, headers or request bodies.
    """


@runtime_checkable
class ModelProvider(Protocol):
    """A text-completion provider.

    Deliberately minimal. Netra drives tool use through a validated JSON
    protocol in the agent rather than a provider-native tool API, so every
    provider -- including gateways that only forward plain completions -- can
    run the same investigation.
    """

    @property
    def name(self) -> str:
        """Display name, e.g. "AgentRouter". Shown in the UI, never a secret."""

    @property
    def model(self) -> str:
        """Model identifier in use, e.g. "claude-sonnet-4-5-20250929"."""

    @property
    def model_label(self) -> str:
        """Human-readable model name, e.g. "Claude Sonnet 4.5"."""

    def complete(
        self,
        *,
        system: str,
        messages: list[Message],
        max_tokens: int,
        temperature: float | None = None,
    ) -> Completion:
        """Produce a completion, or raise `ModelUnavailable`."""


@dataclass(slots=True)
class ProviderUsage:
    """Running total for one investigation, so cost is never a surprise."""

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_units: float = 0.0
    cost_unit_name: str | None = None
    _completions: list[Completion] = field(default_factory=list)

    def record(self, completion: Completion) -> None:
        self.calls += 1
        self.input_tokens += completion.input_tokens or 0
        self.output_tokens += completion.output_tokens or 0
        self.cost_units += completion.cost_units or 0.0
        if completion.cost_unit_name:
            self.cost_unit_name = completion.cost_unit_name
        self._completions.append(completion)


__all__ = [
    "Completion",
    "Message",
    "ModelProvider",
    "ModelUnavailable",
    "ProviderUsage",
    "Role",
]
