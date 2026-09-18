"""OpenRouter provider: the preferred remote inference path.

OpenRouter exposes an OpenAI-compatible chat completions API in front of many
model vendors. Netra talks to it with a pool of authorized credentials so a
transient failure on one account does not end an investigation, and with a
server-side model allowlist so a model name can never come from user input.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Final
from urllib import error, parse, request

from .base import Completion, ModelExhausted, ModelRequest, ModelUnavailable, Tier
from .keypool import KeyHealth, KeyPool

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL: Final = "https://openrouter.ai/api/v1"
COMPLETIONS_PATH: Final = "/chat/completions"

#: OpenRouter asks integrations to identify themselves; these appear in the
#: account's activity so usage is attributable to Netra.
USER_AGENT: Final = "Netra-Investigator/0.1"
REFERER: Final = "https://github.com/netra-security/netra"
TITLE: Final = "Netra"

#: Rate limiting: rest this credential, then try the next authorized one.
RATE_LIMIT_STATUS: Final = 429
#: Budget or credit exhaustion: retrying this credential cannot succeed.
PAYMENT_STATUS: Final = 402
#: Credential rejected outright.
AUTH_STATUS: Final = frozenset({401, 403})
RETRYABLE_STATUS: Final = frozenset({408, 500, 502, 503, 504})

#: Presentation names for the models Netra is configured to use.
MODEL_LABELS: Final[dict[str, str]] = {
    "anthropic/claude-opus-4.5": "Claude Opus 4.5",
    "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
    "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
    "deepseek/deepseek-v4-flash-0731:free": "DeepSeek V4 Flash",
    "nvidia/nemotron-3-super-120b-a12b:free": "Nemotron 3 Super 120B",
    "nvidia/nemotron-3-ultra-550b-a55b:free": "Nemotron 3 Ultra 550B",
    "z-ai/glm-5.2:free": "GLM 5.2",
    "qwen/qwen3.8-27b:free": "Qwen 3.8 27B",
}


def model_label(model_id: str) -> str:
    """Human-readable model name; falls back to the id rather than guessing."""
    return MODEL_LABELS.get(model_id, model_id)


class OpenRouterProvider:
    """Calls an allowlisted model through OpenRouter."""

    def __init__(
        self,
        *,
        key_pool: KeyPool,
        models_by_tier: dict[Tier, list[str]],
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: float = 120.0,
        max_attempts: int = 3,
    ) -> None:
        self._keys = key_pool
        self._models = models_by_tier
        self._base_url = _require_https(base_url)
        self._timeout_s = timeout_s
        self._max_attempts = max_attempts
        #: Model actually used by the last successful call, for provenance.
        self.last_model: str | None = None

    @property
    def name(self) -> str:
        return "OpenRouter"

    def available(self) -> bool:
        return self._keys.configured and self._keys.available_count > 0

    def models_for(self, tier: Tier) -> list[str]:
        """Allowlisted models for a tier, strongest first.

        A tier with no configured model falls back to STANDARD rather than
        failing, so a partial configuration still works.
        """
        return self._models.get(tier) or self._models.get(Tier.STANDARD) or []

    def health(self) -> list[dict[str, object]]:
        return self._keys.snapshot()

    def generate(self, request_: ModelRequest) -> Completion:
        """Try each allowlisted model for the tier, across authorized credentials.

        Moving to another model or credential happens only for failures where it
        can help: a rate limit, an exhausted account, or a transient server
        error. A bad request is returned immediately rather than replayed.
        """
        candidates = self.models_for(request_.tier)
        if not candidates:
            raise ModelUnavailable("No OpenRouter model is allowlisted for this tier.")
        if not self._keys.configured:
            raise ModelUnavailable("No OpenRouter credentials are configured.")

        last_error: str = "OpenRouter had no available capacity."

        for model in candidates:
            for _ in range(self._max_attempts):
                acquired = self._keys.acquire()
                if acquired is None:
                    # Every credential is cooling or retired; another model will
                    # not help, so stop rather than spin.
                    raise ModelExhausted(last_error)
                secret, health = acquired

                try:
                    return self._call(model, secret, health, request_)
                except _RateLimited as err:
                    self._keys.record_rate_limited(health)
                    last_error = str(err)
                except _Exhausted as err:
                    self._keys.record_exhausted(health, str(err))
                    last_error = str(err)
                except _Transient as err:
                    self._keys.record_failure(health, str(err))
                    last_error = str(err)
                except _ModelRejected as err:
                    # The credential is fine; this model is not usable. Try the
                    # next allowlisted model instead of burning the pool.
                    self._keys.record_success(health)
                    last_error = str(err)
                    break

        raise ModelExhausted(last_error)

    # -- transport ---------------------------------------------------------

    def _call(
        self, model: str, secret: str, health: KeyHealth, request_: ModelRequest
    ) -> Completion:
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": request_.max_tokens,
            "messages": [
                {"role": "system", "content": request_.system},
                *({"role": m.role, "content": m.content} for m in request_.messages),
            ],
        }
        if request_.temperature is not None:
            payload["temperature"] = request_.temperature

        started = time.monotonic()
        req = request.Request(  # noqa: S310 - scheme validated in _require_https
            f"{self._base_url}{COMPLETIONS_PATH}",
            data=json.dumps(payload).encode(),
            headers={
                "authorization": f"Bearer {secret}",
                "content-type": "application/json",
                "user-agent": USER_AGENT,
                "http-referer": REFERER,
                "x-title": TITLE,
            },
            method="POST",
        )

        try:
            with request.urlopen(req, timeout=self._timeout_s) as response:  # noqa: S310
                body = json.loads(response.read().decode())
        except error.HTTPError as err:
            raise _classify(err.code, _read_body(err)) from None
        except (error.URLError, TimeoutError) as err:
            raise _Transient(f"OpenRouter could not be reached: {err.reason}") from None
        except json.JSONDecodeError:
            raise _Transient("OpenRouter returned a malformed response.") from None

        latency_ms = int((time.monotonic() - started) * 1000)

        # A 200 can still carry a provider-side error for the chosen model.
        if not body.get("choices"):
            message = str((body.get("error") or {}).get("message") or "no completion returned")
            raise _ModelRejected(f"{model_label(model)} returned no completion: {message[:160]}")

        self._keys.record_success(health)
        self.last_model = model

        choice = body["choices"][0]
        text = (choice.get("message") or {}).get("content") or ""
        usage = body.get("usage") or {}

        return Completion(
            text=text,
            model=model,
            provider=self.name,
            stop_reason=choice.get("finish_reason"),
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
            cost_usd=float(usage.get("cost") or 0.0),
            latency_ms=latency_ms,
        )


# -- failure classification ------------------------------------------------
# Distinguishing these is what keeps the pool honest: a rate limit is rested, an
# exhausted account is retired, and neither is reported as the other.


class _RateLimited(ModelUnavailable):
    pass


class _Exhausted(ModelUnavailable):
    pass


class _Transient(ModelUnavailable):
    pass


class _ModelRejected(ModelUnavailable):
    pass


def _classify(status: int, body: str) -> ModelUnavailable:
    if status == RATE_LIMIT_STATUS:
        return _RateLimited("OpenRouter rate limited this credential.")
    if status == PAYMENT_STATUS:
        return _Exhausted(
            "This OpenRouter account has no remaining credits for the requested model."
        )
    if status in AUTH_STATUS:
        return _Exhausted("OpenRouter rejected this credential.")
    if status in RETRYABLE_STATUS:
        return _Transient(f"OpenRouter returned HTTP {status}.")
    if status == 400 and "not a valid model" in body.lower():
        return _ModelRejected("OpenRouter does not recognise the requested model.")
    # Anything else is a request problem: replaying it would waste capacity.
    return _ModelRejected(f"OpenRouter returned HTTP {status}.")


def _read_body(err: error.HTTPError) -> str:
    try:
        return err.read().decode(errors="replace")[:500]
    except Exception:  # noqa: BLE001 - the body is optional context
        return ""


def _require_https(base_url: str) -> str:
    """Reject any base URL that is not an HTTP(S) endpoint.

    The gateway URL is configuration, and configuration can be wrong or
    hostile. Constraining the scheme means a misconfigured value cannot turn an
    outbound model call into a local file read.
    """
    cleaned = base_url.strip().rstrip("/")
    parsed = parse.urlparse(cleaned)
    if parsed.scheme not in ("https", "http"):
        raise ModelUnavailable(
            f"The model endpoint must be http(s); got {parsed.scheme or 'no'} scheme."
        )
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1"):
        raise ModelUnavailable("The model endpoint must use HTTPS outside local development.")
    if not parsed.netloc:
        raise ModelUnavailable("The model endpoint is missing a host.")
    return cleaned


__all__ = ["DEFAULT_BASE_URL", "MODEL_LABELS", "OpenRouterProvider", "model_label"]
