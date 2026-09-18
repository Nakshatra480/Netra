"""Ollama provider: the local fallback path.

Ollama runs models on the developer's own machine, so it costs nothing and
works offline. It is a *local development and demo* fallback: Netra does not
deploy Ollama to AWS, because a hosted GPU runtime would dominate the running
cost of the entire system for a fallback that is rarely exercised.

Nothing here assumes Ollama is installed or that a usable model is present.
Both are detected, and when no capable model is available Netra says so and
keeps its deterministic analysis rather than inventing a response.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Final
from urllib import error, request

from .base import Completion, ModelRequest, ModelUnavailable
from .openrouter import _require_https

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL: Final = "http://localhost:11434"
TAGS_PATH: Final = "/api/tags"
CHAT_PATH: Final = "/api/chat"

#: Local models Netra considers capable enough to investigate a repository,
#: strongest first. Embedding models and tiny chat models are deliberately
#: absent: a weak answer about a security finding is worse than no answer.
DEFAULT_ALLOWED_MODELS: Final[tuple[str, ...]] = (
    "qwen2.5-coder:32b",
    "qwen2.5-coder:14b",
    "deepseek-coder-v2:16b",
    "qwen2.5-coder:7b",
    "llama3.3:70b",
    "llama3.1:8b",
)

#: What to suggest when nothing capable is installed. Chosen for a useful
#: capability-to-size ratio rather than being the largest available.
SUGGESTED_MODEL: Final = "qwen2.5-coder:7b"


class OllamaProvider:
    """Calls a locally installed, allowlisted model through Ollama."""

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        allowed_models: tuple[str, ...] = DEFAULT_ALLOWED_MODELS,
        preferred_model: str | None = None,
        timeout_s: float = 180.0,
    ) -> None:
        # The base URL is configuration, so its scheme is constrained here too:
        # a wrong value must not turn a local model call into a file read.
        self._base_url = _require_https(base_url)
        self._allowed = allowed_models
        self._preferred = preferred_model
        self._timeout_s = timeout_s
        self._resolved: str | None = None
        self.last_model: str | None = None

    @property
    def name(self) -> str:
        return "Ollama"

    def installed_models(self) -> list[str]:
        """Models present locally, or an empty list if Ollama is not running."""
        try:
            tags = request.Request(f"{self._base_url}{TAGS_PATH}")  # noqa: S310 - scheme validated in _require_https
            with request.urlopen(tags, timeout=5) as response:  # noqa: S310 - scheme validated
                body = json.loads(response.read().decode())
        except (error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            return []
        return [str(m.get("name", "")) for m in body.get("models", []) if m.get("name")]

    def resolve_model(self) -> str | None:
        """Pick the strongest allowlisted model that is actually installed.

        An explicitly configured model is honoured only if it is both installed
        and allowlisted, so configuration cannot smuggle in an arbitrary model.
        """
        installed = self.installed_models()
        if not installed:
            return None

        # Ollama reports "name:tag"; match on either the full name or the base.
        def present(candidate: str) -> str | None:
            for name in installed:
                if name == candidate or name.split(":")[0] == candidate.split(":")[0]:
                    return name
            return None

        if self._preferred:
            if self._preferred not in self._allowed:
                logger.warning(
                    "configured Ollama model %s is not in the capable-model allowlist",
                    self._preferred,
                )
            else:
                match = present(self._preferred)
                if match:
                    return match

        for candidate in self._allowed:
            match = present(candidate)
            if match:
                return match
        return None

    def available(self) -> bool:
        self._resolved = self.resolve_model()
        return self._resolved is not None

    def diagnosis(self) -> str:
        """Why Ollama cannot serve a request, in words a developer can act on."""
        installed = self.installed_models()
        if not installed:
            return (
                "Ollama is not running or has no models. Start it and run "
                f"`ollama pull {SUGGESTED_MODEL}` to enable the local fallback."
            )
        return (
            "No capable local fallback model available. Ollama has "
            f"{len(installed)} model(s) installed, none of which are in Netra's "
            f"capable-model allowlist. Run `ollama pull {SUGGESTED_MODEL}`."
        )

    def generate(self, request_: ModelRequest) -> Completion:
        model = self._resolved or self.resolve_model()
        if model is None:
            raise ModelUnavailable(self.diagnosis())

        payload: dict[str, Any] = {
            "model": model,
            "stream": False,
            "messages": [
                {"role": "system", "content": request_.system},
                *({"role": m.role, "content": m.content} for m in request_.messages),
            ],
            "options": {
                "temperature": request_.temperature if request_.temperature is not None else 0.0,
                "num_predict": request_.max_tokens,
            },
        }

        started = time.monotonic()
        try:
            req = request.Request(  # noqa: S310 - scheme validated in _require_https
                f"{self._base_url}{CHAT_PATH}",
                data=json.dumps(payload).encode(),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with request.urlopen(req, timeout=self._timeout_s) as response:  # noqa: S310
                body = json.loads(response.read().decode())
        except (error.URLError, TimeoutError, OSError) as err:
            raise ModelUnavailable(f"Ollama could not be reached: {err}") from None
        except json.JSONDecodeError:
            raise ModelUnavailable("Ollama returned a malformed response.") from None

        text = (body.get("message") or {}).get("content") or ""
        if not text:
            raise ModelUnavailable("Ollama returned an empty response.")

        self.last_model = model
        return Completion(
            text=text,
            model=model,
            provider=self.name,
            stop_reason=body.get("done_reason"),
            input_tokens=body.get("prompt_eval_count"),
            output_tokens=body.get("eval_count"),
            # Local inference has no per-call charge.
            cost_usd=0.0,
            latency_ms=int((time.monotonic() - started) * 1000),
        )


__all__ = [
    "DEFAULT_ALLOWED_MODELS",
    "DEFAULT_BASE_URL",
    "SUGGESTED_MODEL",
    "OllamaProvider",
]
