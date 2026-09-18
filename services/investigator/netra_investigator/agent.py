"""The investigation agent.

Netra runs deterministic analysis first and asks a model only for what code
cannot decide: what this change *means* for a reviewer. That ordering is both
the trust model and the token strategy -- the expensive component runs last, on
the smallest sufficient context, and its output is validated before use.

    deterministic analysis
        -> prefilter: is a model worth invoking at all?
        -> minimal diff-first context, deduplicated and budgeted
        -> one structured call (more only if new evidence is needed)
        -> schema validation
        -> deterministic verification remains authoritative

Tool use runs over an explicit JSON protocol rather than a provider-native tool
API, so the security boundary is identical on every provider: the model emits a
tool *name* and typed arguments, deterministic code validates them, and only
then does the allowlist build a command. The model never emits a command.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from .config import InvestigatorConfig
from .context import ContextBudget, ContextBuilder, PrefilterDecision
from .providers import Message, ModelRequest, ModelRouter, Tier
from .sandbox import CommandDenied
from .tools import InvestigationTools

logger = logging.getLogger(__name__)

#: Severities the model may propose. Anything else is rejected rather than
#: coerced, because a silently-corrected severity is a lie about confidence.
ALLOWED_SEVERITIES = frozenset({"INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"})

TOOL_NAMES = frozenset(
    {
        "list_changed_files",
        "inspect_diff",
        "search_repository",
        "find_references",
        "read_file",
        "list_files",
        "inspect_git_history",
    }
)

SYSTEM_PROMPT = """\
You are Netra's change investigator. You explain what a code change could cause.

Deterministic analysis has already run and its findings are given to you below. \
Your job is to explain the consequence to a reviewer, not to re-derive it.

You may request more evidence by calling a read-only tool, but only when the \
context you were given is genuinely insufficient. Prefer answering directly.

TOOLS
- list_changed_files{}                files this change added, modified or deleted
- inspect_diff{path?}                 the unified diff, optionally for one path
- search_repository{query, path?}     literal string search
- find_references{symbol, path?}      whole-word references to an identifier
- read_file{path}                     read a repository file
- list_files{path?}                   list tracked files
- inspect_git_history{path?, limit?}  recent commits

PROTOCOL
Reply with exactly one JSON object and nothing else. Either request evidence:

{"tool": "read_file", "args": {"path": "src/client/config.js"}}

or report:

{"done": true,
 "summary": "one sentence naming the consequence of this change",
 "reasoning_for_reviewer": "two or three sentences of plain explanation",
 "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
 "suspected_secrets": ["ENV_VAR_NAME"],
 "suspected_exposed_files": ["path/to/file"],
 "confidence": 0.0}

RULES
- Never say "verified" or "confirmed". A separate deterministic checker decides \
that, not you.
- Never invent a file path, line number or identifier.
- Do not restate the repository contents back to me.
- Do not explain your reasoning outside the JSON object.
- Be brief. A reviewer reads your summary in ten seconds.
"""


@dataclass(slots=True)
class AgentHypothesis:
    """What the model believes, before anything has been checked."""

    summary: str = ""
    explanation: str = ""
    severity: str | None = None
    confidence: float | None = None
    suspected_secrets: list[str] = field(default_factory=list)
    suspected_files: list[str] = field(default_factory=list)

    #: Provenance and accounting, shown in the UI and persisted.
    metadata: dict[str, Any] = field(default_factory=dict)
    tool_calls: int = 0

    model_unavailable: bool = False
    unavailable_reason: str | None = None

    @classmethod
    def unavailable(cls, reason: str, metadata: dict[str, Any] | None = None) -> AgentHypothesis:
        return cls(
            model_unavailable=True,
            unavailable_reason=reason,
            metadata=metadata or {},
        )

    @property
    def model_label(self) -> str | None:
        return self.metadata.get("modelLabel")

    @property
    def provider(self) -> str | None:
        return self.metadata.get("provider")

    def to_metadata(self) -> dict[str, Any]:
        """Provenance for persistence and display. Never includes credentials."""
        return {
            **self.metadata,
            "toolCalls": self.tool_calls,
            "modelUsed": not self.model_unavailable,
            "unavailableReason": self.unavailable_reason,
        }


def investigate(
    tools: InvestigationTools,
    config: InvestigatorConfig,
    change_description: str,
    router: ModelRouter | None = None,
    *,
    findings_context: str = "",
    decision: PrefilterDecision | None = None,
) -> AgentHypothesis:
    """Interpret a change, if a model is available and worth invoking.

    Returns an unavailable hypothesis rather than raising: an absent model is an
    expected state for Netra, and the deterministic analyzer -- not this -- is
    what produces the finding.
    """
    if router is None:
        from .providers import build_router

        router = build_router(config)

    # Cheapest possible exit: if deterministic analysis found nothing to
    # interpret, no context is built and no provider is contacted.
    if decision is not None and not decision.needs_model:
        return AgentHypothesis.unavailable(
            decision.reason, {"display": "Not required — deterministic analysis was conclusive"}
        )

    blocked = router.preflight()
    if blocked is not None:
        return AgentHypothesis.unavailable(blocked, router.metadata())

    tier = Tier(decision.suggested_tier) if decision else Tier.STANDARD
    builder = ContextBuilder(
        budget=ContextBudget(
            max_input_tokens=config.max_input_tokens,
            max_fragment_tokens=config.max_fragment_tokens,
        )
    )
    builder.add("change", "under investigation", change_description)
    if findings_context:
        builder.add("deterministic findings", "already established", findings_context)

    runner = _ToolRunner(tools, config.max_fragment_tokens)
    conversation: list[Message] = [
        Message(
            role="user",
            content=(
                f"{builder.render()}\n\n"
                "Explain the consequence of this change. Reply with one JSON "
                "object: your report, or a tool call if you genuinely need more."
            ),
        )
    ]

    for _turn in range(config.max_model_turns):
        completion = router.generate(
            ModelRequest(
                system=SYSTEM_PROMPT,
                messages=tuple(conversation),
                max_tokens=config.max_output_tokens,
                tier=tier,
            )
        )
        if completion is None:
            return AgentHypothesis.unavailable(
                router.outcome.unavailable_reason or "no model was available",
                _metadata(router, builder, runner),
            )

        action = _parse_action(completion.text)

        if action is None:
            conversation += [
                Message(role="assistant", content=completion.text[:1000]),
                Message(
                    role="user",
                    content=(
                        "That was not a single JSON object. Reply with exactly one "
                        "JSON object: your report, or a tool call."
                    ),
                ),
            ]
            continue

        if action.get("done"):
            return _finalize(action, router, builder, runner)

        tool_name = str(action.get("tool", ""))
        args = action.get("args") if isinstance(action.get("args"), dict) else {}
        result = runner.run(tool_name, args)

        # Deduplicate through the same builder: evidence already in context is
        # not sent twice, however often the model asks for it.
        fresh = builder.add("tool result", tool_name, result)
        conversation += [
            Message(role="assistant", content=json.dumps(action)),
            Message(
                role="user",
                content=(
                    f"Tool result for {tool_name}:\n{result}"
                    if fresh
                    else f"You already have the result of {tool_name} above. Report now."
                ),
            ),
        ]

    logger.info("agent reached its turn budget without concluding")
    return AgentHypothesis.unavailable(
        "the model did not reach a conclusion within its turn budget",
        _metadata(router, builder, runner),
    )


class _ToolRunner:
    """Dispatches a validated tool call to the sandbox-backed tools."""

    def __init__(self, tools: InvestigationTools, max_result_tokens: int) -> None:
        self._tools = tools
        self._max_chars = int(max_result_tokens * 3.7)
        self.calls = 0

    def run(self, name: str, args: dict[str, Any]) -> str:
        self.calls += 1
        if name not in TOOL_NAMES:
            # Nothing is executed, and the model is told why so it can choose a
            # real tool on its next turn.
            return json.dumps({"error": f"unknown tool: {name!r}"})
        try:
            from .context import summarize_output

            return summarize_output(self._dispatch(name, args), self._max_chars)
        except CommandDenied as err:
            return json.dumps({"error": f"rejected by the tool allowlist: {err}"})
        except Exception as err:  # noqa: BLE001 - a tool failure must not end the run
            logger.warning("tool %s failed: %s", name, err)
            return json.dumps({"error": "the tool failed to run"})

    def _dispatch(self, name: str, args: dict[str, Any]) -> str:
        path = _optional_str(args.get("path"))

        match name:
            case "list_changed_files":
                return json.dumps(
                    [
                        {"path": c.path, "changeType": c.change_type}
                        for c in self._tools.changed_files()
                    ]
                )
            case "inspect_diff":
                return self._tools.inspect_diff(path)
            case "search_repository":
                query = _require_str(args, "query")
                return json.dumps(_matches(self._tools.search_repository(query, path or ".")))
            case "find_references":
                symbol = _require_str(args, "symbol")
                return json.dumps(_matches(self._tools.find_references(symbol, path or ".")))
            case "read_file":
                return "\n".join(self._tools.read_file(_require_str(args, "path")))
            case "list_files":
                return json.dumps(self._tools.list_files(path or ".")[:300])
            case "inspect_git_history":
                raw = args.get("limit", 10)
                limit = int(raw) if str(raw).isdigit() else 10
                return json.dumps(self._tools.inspect_git_history(path, limit))
            case _:  # pragma: no cover - guarded by TOOL_NAMES above
                return json.dumps({"error": f"unknown tool: {name!r}"})


def _matches(matches: Any) -> list[dict[str, Any]]:
    return [{"file": m.file, "line": m.line, "text": m.text} for m in matches]


def _require_str(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value:
        raise CommandDenied(f"{key} must be a non-empty string")
    return value


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def _parse_action(raw: str) -> dict[str, Any] | None:
    """Extract the single JSON object the protocol requires.

    Only declared fields are read downstream. Anything else the model produced,
    including reasoning it volunteered around the JSON, is discarded here and
    never reaches storage, an event or the UI.
    """
    match = _JSON_BLOCK.search(raw)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _finalize(
    action: dict[str, Any],
    router: ModelRouter,
    builder: ContextBuilder,
    runner: _ToolRunner,
) -> AgentHypothesis:
    """Validate the model's report before any of it is used."""
    severity = str(action.get("severity", "")).upper()
    confidence = action.get("confidence")

    return AgentHypothesis(
        summary=str(action.get("summary", ""))[:400],
        explanation=str(action.get("reasoning_for_reviewer", ""))[:1200],
        # An out-of-range severity is dropped, not clamped: the deterministic
        # analyzer sets severity anyway, and a coerced value would look like
        # agreement that never happened.
        severity=severity if severity in ALLOWED_SEVERITIES else None,
        confidence=(
            float(confidence)
            if isinstance(confidence, int | float) and 0.0 <= float(confidence) <= 1.0
            else None
        ),
        suspected_secrets=[str(s)[:100] for s in _as_list(action.get("suspected_secrets"))][:20],
        suspected_files=[str(s)[:400] for s in _as_list(action.get("suspected_exposed_files"))][
            :50
        ],
        metadata=_metadata(router, builder, runner),
        tool_calls=runner.calls,
    )


def _metadata(
    router: ModelRouter, builder: ContextBuilder, runner: _ToolRunner
) -> dict[str, Any]:
    return {**router.metadata(), **builder.stats(), "toolCalls": runner.calls}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


__all__ = ["ALLOWED_SEVERITIES", "SYSTEM_PROMPT", "AgentHypothesis", "investigate"]
