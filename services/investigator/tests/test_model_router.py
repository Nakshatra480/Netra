"""Provider selection, failover and budgets.

No test here touches the network: providers are faked so the routing rules --
and the honesty guarantees around them -- can be asserted exactly.
"""

import pytest

from netra_investigator.providers.base import (
    Completion,
    Message,
    ModelExhausted,
    ModelRequest,
    ModelUnavailable,
)
from netra_investigator.providers.keypool import KeyPool, KeyState, fingerprint
from netra_investigator.providers.router import Budget, ModelRouter


def a_request(max_tokens: int = 100) -> ModelRequest:
    return ModelRequest(
        system="s", messages=(Message(role="user", content="u"),), max_tokens=max_tokens
    )


class FakeRemote:
    name = "OpenRouter"

    def __init__(self, *, behaviour=None, available=True):
        self._behaviour = behaviour or []
        self._available = available
        self.calls = 0

    def available(self):
        return self._available

    def health(self):
        return [{"key": "key_test", "state": "READY"}]

    def generate(self, request):
        self.calls += 1
        outcome = self._behaviour.pop(0) if self._behaviour else "ok"
        if isinstance(outcome, Exception):
            raise outcome
        return Completion(
            text="remote answer",
            model="anthropic/claude-sonnet-4.5",
            provider=self.name,
            input_tokens=100,
            output_tokens=50,
            cost_usd=0.002,
        )


class FakeLocal:
    name = "Ollama"

    def __init__(self, *, available=True, fails=False):
        self._available = available
        self._fails = fails
        self.calls = 0

    def available(self):
        return self._available

    def diagnosis(self):
        return "No capable local fallback model available."

    def generate(self, request):
        self.calls += 1
        if self._fails:
            raise ModelUnavailable("Ollama could not be reached")
        return Completion(
            text="local answer",
            model="qwen2.5-coder:7b",
            provider=self.name,
            input_tokens=100,
            output_tokens=40,
            cost_usd=0.0,
        )


class TestRouting:
    def test_prefers_the_remote_provider(self):
        local = FakeLocal()
        router = ModelRouter(remote=FakeRemote(), local=local)
        completion = router.generate(a_request())

        assert completion.provider == "OpenRouter"
        assert local.calls == 0
        assert router.outcome.describe() == "OpenRouter · Claude Sonnet 4.5"

    def test_falls_back_to_local_when_remote_capacity_is_gone(self):
        remote = FakeRemote(behaviour=[ModelExhausted("all credentials rate limited")])
        local = FakeLocal()
        router = ModelRouter(remote=remote, local=local)

        completion = router.generate(a_request())
        assert completion.provider == "Ollama"
        assert local.calls == 1
        # The UI must be able to say *why* it fell back.
        assert "rate limited" in (router.outcome.fallback_reason or "")
        assert router.outcome.describe() == "Ollama · qwen2.5-coder:7b"

    def test_falls_back_when_remote_reports_itself_unavailable(self):
        router = ModelRouter(remote=FakeRemote(available=False), local=FakeLocal())
        assert router.generate(a_request()).provider == "Ollama"

    def test_returns_nothing_when_no_provider_can_serve(self):
        router = ModelRouter(
            remote=FakeRemote(available=False), local=FakeLocal(available=False)
        )
        assert router.generate(a_request()) is None
        # An absent model is an expected state, not an exception.
        assert not router.outcome.model_used
        assert "No capable local fallback" in (router.outcome.unavailable_reason or "")

    def test_reports_deterministic_only_honestly(self):
        router = ModelRouter(remote=None, local=None)
        assert router.generate(a_request()) is None
        assert router.outcome.describe().startswith("AI unavailable")
        assert router.metadata()["modelUsed"] is False

    def test_a_failing_local_fallback_does_not_raise(self):
        router = ModelRouter(
            remote=FakeRemote(behaviour=[ModelExhausted("gone")]),
            local=FakeLocal(fails=True),
        )
        assert router.generate(a_request()) is None
        assert not router.outcome.model_used

    def test_preflight_skips_work_when_nothing_can_run(self):
        router = ModelRouter(
            remote=FakeRemote(available=False), local=FakeLocal(available=False)
        )
        assert router.preflight() is not None
        # A usable provider means no blocking reason.
        assert ModelRouter(remote=FakeRemote(), local=None).preflight() is None


class TestBudgets:
    def test_stops_at_the_turn_budget(self):
        router = ModelRouter(remote=FakeRemote(), local=None, budget=Budget(max_turns=2))
        assert router.generate(a_request()) is not None
        assert router.generate(a_request()) is not None
        assert router.generate(a_request()) is None
        assert "turn limit" in (router.outcome.unavailable_reason or "")

    def test_stops_at_the_cost_budget(self):
        router = ModelRouter(
            remote=FakeRemote(), local=None, budget=Budget(max_turns=99, max_cost_usd=0.003)
        )
        assert router.generate(a_request()) is not None  # 0.002 spent
        assert router.generate(a_request()) is not None  # 0.004 spent, now over
        assert router.generate(a_request()) is None
        assert "cost budget" in (router.outcome.unavailable_reason or "")

    def test_stops_at_the_token_budget(self):
        router = ModelRouter(
            remote=FakeRemote(),
            local=None,
            budget=Budget(max_turns=99, max_total_tokens=200),
        )
        router.generate(a_request())  # 150 tokens
        router.generate(a_request())  # 300 tokens, now over
        assert router.generate(a_request()) is None
        assert "token budget" in (router.outcome.unavailable_reason or "")

    def test_clamps_the_output_request_to_the_budget(self):
        class Recording(FakeRemote):
            seen = 0

            def generate(self, request):
                Recording.seen = request.max_tokens
                return super().generate(request)

        router = ModelRouter(remote=Recording(), local=None, budget=Budget(max_output_tokens=200))
        router.generate(a_request(max_tokens=99_999))
        assert Recording.seen == 200

    def test_never_loops(self):
        # Every credential gone and no local model: one attempt, then stop.
        remote = FakeRemote(behaviour=[ModelExhausted("gone")])
        router = ModelRouter(remote=remote, local=None)
        assert router.generate(a_request()) is None
        assert remote.calls == 1


class TestUsageAccounting:
    def test_records_provider_model_and_cost(self):
        router = ModelRouter(remote=FakeRemote(), local=None)
        router.generate(a_request())
        metadata = router.metadata()

        assert metadata["provider"] == "OpenRouter"
        assert metadata["model"] == "anthropic/claude-sonnet-4.5"
        assert metadata["inputTokens"] == 100
        assert metadata["outputTokens"] == 50
        assert metadata["costUsd"] == pytest.approx(0.002)

    def test_records_the_fallback_reason(self):
        router = ModelRouter(
            remote=FakeRemote(behaviour=[ModelExhausted("credentials exhausted")]),
            local=FakeLocal(),
        )
        router.generate(a_request())
        assert "exhausted" in str(router.metadata()["fallbackReason"])

    def test_metadata_never_contains_credentials(self):
        router = ModelRouter(remote=FakeRemote(), local=FakeLocal())
        router.generate(a_request())
        blob = str(router.metadata()) + str(router.health())
        assert "sk-or-v1" not in blob
        assert "Bearer" not in blob


class TestKeyPool:
    def test_spreads_requests_across_authorized_credentials(self):
        pool = KeyPool.from_secrets(["a", "b", "c"])
        seen = {pool.acquire()[1].fingerprint for _ in range(3)}
        assert len(seen) == 3

    def test_deduplicates_configured_credentials(self):
        # A duplicated key would misreport capacity as larger than it is.
        assert len(KeyPool.from_secrets(["a", "a", "b"])) == 2

    def test_rests_a_rate_limited_credential_then_restores_it(self):
        pool = KeyPool.from_secrets(["a"])
        _, health = pool.acquire(now=0.0)
        pool.record_rate_limited(health, now=0.0)

        assert health.state is KeyState.COOLING
        # Still resting: the pool declines rather than hammering the provider.
        assert pool.acquire(now=1.0) is None
        # Backoff elapsed: returned to service rather than lost permanently.
        assert pool.acquire(now=120.0) is not None

    def test_backoff_grows_with_repeated_rate_limits(self):
        pool = KeyPool.from_secrets(["a"])
        _, health = pool.acquire(now=0.0)
        pool.record_rate_limited(health, now=0.0)
        first = health.cooling_until
        health.state = KeyState.READY
        pool.record_rate_limited(health, now=0.0)
        assert health.cooling_until > first

    def test_retires_an_exhausted_credential_permanently(self):
        pool = KeyPool.from_secrets(["a"])
        _, health = pool.acquire()
        pool.record_exhausted(health, "no remaining credits")

        assert health.state is KeyState.EXHAUSTED
        # Never retried, however long we wait: retrying cannot succeed.
        assert pool.acquire(now=10_000.0) is None

    def test_retires_a_persistently_failing_credential(self):
        pool = KeyPool.from_secrets(["a"])
        _, health = pool.acquire()
        for _ in range(3):
            pool.record_failure(health, "bad gateway")
        assert health.state is KeyState.EXHAUSTED

    def test_fingerprints_never_reveal_the_secret(self):
        secret = "sk-or-v1-a-real-looking-secret-value"
        printed = fingerprint(secret)
        assert secret not in printed
        assert printed.startswith("key_")

    def test_snapshot_is_safe_to_display(self):
        pool = KeyPool.from_secrets(["sk-or-v1-secret"])
        assert "sk-or-v1-secret" not in str(pool.snapshot())

    def test_an_empty_pool_is_simply_unconfigured(self):
        pool = KeyPool.from_secrets([])
        assert not pool.configured
        assert pool.acquire() is None
