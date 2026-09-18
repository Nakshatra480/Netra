"""A failover pool of authorized API credentials.

Several credentials are configured so that a transient outage on one account
does not stop an investigation. This is a *reliability* mechanism, not a way
around a provider's limits:

* each credential is used within its own account's allowance;
* a credential that reports a rate limit is rested, with backoff, rather than
  hammered;
* a credential whose budget is exhausted is retired for the process rather than
  retried;
* when every credential is unavailable the pool says so, and the caller falls
  back or degrades honestly. It never loops.

Selection is deterministic given the same health state, so behaviour is
reproducible in tests and in an incident.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from enum import StrEnum

logger = logging.getLogger(__name__)

#: Backoff applied after consecutive rate limits on one credential.
BACKOFF_SCHEDULE_S = (5.0, 15.0, 45.0, 120.0)


class KeyState(StrEnum):
    READY = "READY"
    #: Temporarily rested after a rate limit; returns to READY on its own.
    COOLING = "COOLING"
    #: Budget spent or credential rejected; not retried in this process.
    EXHAUSTED = "EXHAUSTED"


@dataclass(slots=True)
class KeyHealth:
    """Health of one credential. Holds a fingerprint, never the secret."""

    #: Stable, non-reversible identifier used in logs and metrics.
    fingerprint: str
    state: KeyState = KeyState.READY
    consecutive_failures: int = 0
    total_requests: int = 0
    total_failures: int = 0
    cooling_until: float = 0.0
    last_error: str | None = None

    def snapshot(self) -> dict[str, object]:
        return {
            "key": self.fingerprint,
            "state": str(self.state),
            "requests": self.total_requests,
            "failures": self.total_failures,
            "lastError": self.last_error,
        }


@dataclass(slots=True)
class KeyPool:
    """Holds credentials and their health."""

    _secrets: list[str] = field(default_factory=list, repr=False)
    _health: list[KeyHealth] = field(default_factory=list)
    _cursor: int = 0

    @classmethod
    def from_secrets(cls, secrets: list[str]) -> KeyPool:
        cleaned = [s.strip() for s in secrets if s and s.strip()]
        # Duplicates would misreport capacity as larger than it is.
        unique = list(dict.fromkeys(cleaned))
        return cls(
            _secrets=unique,
            _health=[KeyHealth(fingerprint=fingerprint(s)) for s in unique],
        )

    def __len__(self) -> int:
        return len(self._secrets)

    @property
    def configured(self) -> bool:
        return bool(self._secrets)

    def acquire(self, now: float | None = None) -> tuple[str, KeyHealth] | None:
        """Return the next usable credential, or None if the pool has none.

        Credentials whose cooldown has elapsed are returned to service first,
        so a brief rate limit does not permanently shrink the pool.
        """
        if not self._secrets:
            return None
        moment = now if now is not None else time.monotonic()
        self._revive(moment)

        for offset in range(len(self._secrets)):
            index = (self._cursor + offset) % len(self._secrets)
            if self._health[index].state is KeyState.READY:
                # Advance so consecutive calls spread across the pool rather
                # than leaning on one account.
                self._cursor = (index + 1) % len(self._secrets)
                return self._secrets[index], self._health[index]
        return None

    def _revive(self, now: float) -> None:
        for health in self._health:
            if health.state is KeyState.COOLING and now >= health.cooling_until:
                health.state = KeyState.READY
                health.consecutive_failures = 0

    def record_success(self, health: KeyHealth) -> None:
        health.total_requests += 1
        health.consecutive_failures = 0
        health.last_error = None
        if health.state is KeyState.COOLING:
            health.state = KeyState.READY

    def record_rate_limited(self, health: KeyHealth, now: float | None = None) -> None:
        """Rest a credential that asked to be slowed down."""
        moment = now if now is not None else time.monotonic()
        health.total_requests += 1
        health.total_failures += 1
        health.consecutive_failures += 1
        health.last_error = "rate limited"

        index = min(health.consecutive_failures - 1, len(BACKOFF_SCHEDULE_S) - 1)
        health.state = KeyState.COOLING
        health.cooling_until = moment + BACKOFF_SCHEDULE_S[index]
        logger.info(
            "credential %s cooling for %.0fs after a rate limit",
            health.fingerprint,
            BACKOFF_SCHEDULE_S[index],
        )

    def record_exhausted(self, health: KeyHealth, reason: str) -> None:
        """Retire a credential whose authorized budget is spent."""
        health.total_requests += 1
        health.total_failures += 1
        health.state = KeyState.EXHAUSTED
        health.last_error = reason
        logger.info("credential %s retired: %s", health.fingerprint, reason)

    def record_failure(self, health: KeyHealth, reason: str) -> None:
        health.total_requests += 1
        health.total_failures += 1
        health.consecutive_failures += 1
        health.last_error = reason
        # Repeated hard failures on one credential usually mean it is broken
        # rather than busy, so stop choosing it.
        if health.consecutive_failures >= 3:
            health.state = KeyState.EXHAUSTED

    @property
    def available_count(self) -> int:
        return sum(1 for h in self._health if h.state is KeyState.READY)

    def snapshot(self) -> list[dict[str, object]]:
        """Health for the admin view. Contains no credential material."""
        return [h.snapshot() for h in self._health]


def fingerprint(secret: str) -> str:
    """A short, non-reversible identifier for a credential.

    Logs and metrics need to name *which* credential misbehaved without ever
    holding the credential itself.
    """
    return "key_" + hashlib.sha256(secret.encode()).hexdigest()[:8]


__all__ = ["BACKOFF_SCHEDULE_S", "KeyHealth", "KeyPool", "KeyState", "fingerprint"]
