"""AgentRouter model provider.

AgentRouter is an external model gateway: Netra sends a chat completion to a
route and AgentRouter forwards it to the underlying model vendor. It is not
part of the AWS production platform, and it is the only component outside AWS
that sees investigation context.

Two properties of the route shape the implementation:

* it accepts only `model`, `messages`, `max_tokens` and a few sampling
  parameters -- there is no `system` field and no provider-native tool API, so
  the system prompt is folded into the conversation and tool use is driven by
  the agent's own validated JSON protocol;
* the model list it advertises lags the vendor's actual catalogue, so the model
  id is configuration rather than something discovered at runtime.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Final
from urllib import error, parse, request

from .base import Completion, Message, ModelUnavailable

logger = logging.getLogger(__name__)

#: The AgentRouter route that reaches Anthropic's Messages API.
DEFAULT_ROUTE_KEY: Final = "models.chat.complete.anthropic.messages.mpp"
CAPABILITY_PATH: Final = "/domains/models/capabilities/chat-complete/execute"

#: Presentation names for the models Netra supports. Unknown ids fall back to
#: the raw identifier rather than guessing.
MODEL_LABELS: Final[dict[str, str]] = {
    "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
    "claude-opus-4-5-20251101": "Claude Opus 4.5",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
}

RETRYABLE_STATUS: Final = frozenset({408, 429, 500, 502, 503, 504})

#: Gateway error codes that will not succeed on a retry, whatever the HTTP
#: status suggests. Retrying these wastes an investigation's time budget and,
#: for a billing failure, tells the operator the wrong story.
TERMINAL_ERROR_CODES: Final = frozenset({"INSUFFICIENT_CREDITS"})

#: The gateway sits behind a CDN that rejects unidentified clients, so Netra
#: identifies itself rather than sending a default library user agent.
USER_AGENT: Final = "Netra-Investigator/0.1 (+https://github.com/netra)"


class AgentRouterProvider:
    """Calls a Claude model through AgentRouter's chat-complete capability."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        route_key: str = DEFAULT_ROUTE_KEY,
        timeout_s: float = 90.0,
        max_attempts: int = 3,
    ) -> None:
        if not api_key:
            raise ModelUnavailable("No AgentRouter API key is configured.")
        self._api_key = api_key
        self._base_url = _require_https(base_url)
        self._model = model
        self._route_key = route_key
        self._timeout_s = timeout_s
        self._max_attempts = max_attempts

    @property
    def name(self) -> str:
        return "AgentRouter"

    @property
    def model(self) -> str:
        return self._model

    @property
    def model_label(self) -> str:
        return MODEL_LABELS.get(self._model, self._model)

    def complete(
        self,
        *,
        system: str,
        messages: list[Message],
        max_tokens: int,
        temperature: float | None = None,
    ) -> Completion:
        payload: dict[str, Any] = {
            "routeKey": self._route_key,
            "model": self._model,
            "max_tokens": max_tokens,
            # Never silently substitute a different vendor: an investigation
            # must be attributable to the model the UI says produced it.
            "allowFallback": False,
            "messages": self._render(system, messages),
        }
        if temperature is not None:
            payload["temperature"] = temperature

        body = self._post(payload)

        if body.get("success") is False:
            raise ModelUnavailable(self._describe(body))

        text = body.get("completionText") or self._text_from_content(body.get("content"))
        if not text:
            raise ModelUnavailable("The model returned an empty response.")

        usage = body.get("usage") or {}
        return Completion(
            text=text,
            model=str(body.get("model") or self._model),
            provider=self.name,
            stop_reason=body.get("stop_reason"),
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
            cost_units=body.get("creditsCharged"),
            cost_unit_name="credits",
        )

    # -- transport ---------------------------------------------------------

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        """POST with bounded retries on transient failures."""
        last_error: str = "The model gateway could not be reached."

        for attempt in range(1, self._max_attempts + 1):
            req = request.Request(  # noqa: S310 - scheme validated in _require_https
                f"{self._base_url}{CAPABILITY_PATH}",
                data=json.dumps(payload).encode(),
                headers={
                    "authorization": f"Bearer {self._api_key}",
                    "content-type": "application/json",
                    "accept": "application/json",
                    "user-agent": USER_AGENT,
                },
                method="POST",
            )
            try:
                with request.urlopen(req, timeout=self._timeout_s) as response:  # noqa: S310 - scheme validated in _require_https
                    return json.loads(response.read().decode())
            except error.HTTPError as err:
                body = _read_body(err)
                detail = self._safe_http_detail(err, body)
                retryable = err.code in RETRYABLE_STATUS and not _is_terminal(body)
                if not retryable or attempt == self._max_attempts:
                    raise ModelUnavailable(detail) from None
                last_error = detail
            except (error.URLError, TimeoutError) as err:
                # The reason can contain a hostname but never a credential.
                last_error = f"The model gateway could not be reached: {err.reason}"
                if attempt == self._max_attempts:
                    raise ModelUnavailable(last_error) from None
            except json.JSONDecodeError:
                raise ModelUnavailable("The model gateway returned a malformed response.") from None

            # Exponential backoff; the caller is a background investigation, so
            # waiting briefly is preferable to failing the run.
            time.sleep(min(2 ** (attempt - 1), 8))

        raise ModelUnavailable(last_error)

    @staticmethod
    def _safe_http_detail(err: error.HTTPError, body: str = "") -> str:
        """Describe an HTTP failure without echoing the request."""
        if "INSUFFICIENT_CREDITS" in body:
            # The reservation scales with max_tokens, so this is as much a
            # configuration hint as a billing one.
            return (
                "The AgentRouter wallet has too few credits for this request. "
                "Add credits, or lower NETRA_MAX_OUTPUT_TOKENS so the gateway "
                "reserves less per call."
            )
        if "error_code" in body and "1010" in body:
            # A CDN rejection is an infrastructure problem, not a bad key, and
            # saying "credentials rejected" would send someone hunting the
            # wrong fault.
            return (
                "The model gateway's CDN rejected Netra's request signature. "
                "This is not a credential problem."
            )
        if err.code == 401:
            return "AgentRouter rejected the credentials configured for Netra."
        if err.code == 403:
            return "AgentRouter refused the request for this route or account."
        if err.code == 402:
            return "The AgentRouter account has no remaining credits."
        if err.code == 429:
            return "AgentRouter is rate limiting Netra's requests."
        return f"AgentRouter returned HTTP {err.code}."

    @staticmethod
    def _describe(body: dict[str, Any]) -> str:
        """Turn a gateway error body into something safe to show a user."""
        raw = str(body.get("error") or "The model request failed.")
        if "not_found_error" in raw and "model" in raw:
            return (
                "The configured model is not available through this AgentRouter "
                "route. Set AI_MODEL to a model the route currently serves."
            )
        if "insufficient" in raw.lower() or "credit" in raw.lower():
            return "The AgentRouter account has no remaining credits."
        # Gateway errors quote the upstream payload; keep only the first clause
        # so a request echo can never reach a log or a screen.
        return raw.split("{", 1)[0].strip() or "The model request failed."

    @staticmethod
    def _render(system: str, messages: list[Message]) -> list[dict[str, str]]:
        """Fold the system prompt into the conversation.

        The route has no `system` field, so the instructions are prepended to
        the first user turn, which is where they carry the same weight.
        """
        rendered = [{"role": m.role, "content": m.content} for m in messages]
        if not system:
            return rendered
        if rendered and rendered[0]["role"] == "user":
            rendered[0] = {
                "role": "user",
                "content": f"{system}\n\n---\n\n{rendered[0]['content']}",
            }
            return rendered
        return [{"role": "user", "content": system}, *rendered]

    @staticmethod
    def _text_from_content(content: Any) -> str:
        if not isinstance(content, list):
            return ""
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )


def _require_https(base_url: str) -> str:
    """Reject any base URL that is not an HTTPS endpoint.

    The gateway URL is configuration, and configuration can be wrong or
    hostile. Constraining the scheme here means a misconfigured value cannot
    turn an outbound model call into a local file read or a request to an
    internal address via an unexpected scheme.
    """
    cleaned = base_url.strip().rstrip("/")
    parsed = parse.urlparse(cleaned)
    if parsed.scheme not in ("https", "http"):
        raise ModelUnavailable(
            f"The model gateway URL must be http(s); got {parsed.scheme or 'no'} scheme."
        )
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1"):
        # Plain HTTP would put the API key and investigation context on the wire.
        raise ModelUnavailable("The model gateway URL must use HTTPS outside local development.")
    if not parsed.netloc:
        raise ModelUnavailable("The model gateway URL is missing a host.")
    return cleaned


def _is_terminal(body: str) -> bool:
    return any(code in body for code in TERMINAL_ERROR_CODES)


def _read_body(err: error.HTTPError) -> str:
    """Read an error body defensively; it is only ever used for classification."""
    try:
        return err.read().decode(errors="replace")[:500]
    except Exception:  # noqa: BLE001 - the body is optional context
        return ""


__all__ = [
    "DEFAULT_ROUTE_KEY",
    "MODEL_LABELS",
    "TERMINAL_ERROR_CODES",
    "USER_AGENT",
    "AgentRouterProvider",
]
