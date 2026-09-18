"""The investigation agent.

The model investigates by *choosing tools*, not by writing commands. Because
Netra's model gateway forwards plain completions with no provider-native tool
API, tool use runs over an explicit JSON protocol:

    model -> {"tool": "...", "args": {...}} -> validation -> allowlist
          -> sandbox -> structured result -> model

The security property is unchanged, and is in fact easier to state: the model
emits a tool *name* and typed arguments. It never emits a command, a path that
skips validation, or anything that reaches a shell. An unknown tool name, a
malformed argument or a rejected path is answered with an error the model can
read, and the loop continues.

Three rules are enforced here rather than requested in the prompt:

* the agent cannot execute a command -- only call a declared tool;
* the agent's claims are never marked verified;
* the agent's private reasoning is never emitted or stored. Only the final
  structured summary leaves this module.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from .config import InvestigatorConfig
from .providers import Message, ModelProvider, ModelUnavailable, ProviderUsage
from .sandbox import CommandDenied
from .tools import InvestigationTools

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are Netra's change investigator. You examine one code change in a repository \
and explain what it could cause.

You work by calling read-only analysis tools. You must not claim anything you \
have not observed through a tool.

Your focus is credential exposure: a change that causes a secret, key, token or \
password to reach a context that publishes it, such as a browser bundle.

TOOLS
- list_changed_files{}                     files this change added, modified or deleted
- inspect_diff{path?}                      the unified diff, optionally for one path
- search_repository{query, path?}          literal string search
- find_references{symbol, path?}           whole-word references to an identifier
- read_file{path}                          read a repository file
- list_files{path?}                        list tracked files
- inspect_git_history{path?, limit?}       recent commits

PROTOCOL
Reply with exactly one JSON object and nothing else. Either call a tool:

{"tool": "search_repository", "args": {"query": "AWS_SECRET_ACCESS_KEY"}}

or, when you have finished investigating, report:

{"done": true,
 "summary": "one sentence naming the consequence of this change",
 "reasoning_for_reviewer": "two or three sentences of plain explanation",
 "suspected_secrets": ["ENV_VAR_NAME"],
 "suspected_exposed_files": ["path/to/file"]}

RULES
- Never say "verified" or "confirmed". A separate deterministic checker decides \
that, not you.
- Never invent a file path, line number or identifier.
- Do not explain your reasoning outside the JSON object.
- Be efficient: a handful of well-chosen tool calls, then report.
"""


@dataclass(slots=True)
class AgentHypothesis:
    """What the model believes, before anything has been checked."""

    summary: str = ""
    explanation: str = ""
    suspected_secrets: list[str] = field(default_factory=list)
    suspected_files: list[str] = field(default_factory=list)

    #: Provenance, shown in the UI so a reader knows what produced the prose.
    provider: str | None = None
    model: str | None = None
    model_label: str | None = None
    tool_calls: int = 0
    usage: ProviderUsage | None = None

    #: True when the model was unavailable and the pipeline proceeded without it.
    model_unavailable: bool = False
    unavailable_reason: str | None = None

    @classmethod
    def unavailable(cls, reason: str) -> AgentHypothesis:
        return cls(model_unavailable=True, unavailable_reason=reason)

    def to_metadata(self) -> dict[str, Any]:
        """Provenance for persistence and display. Never includes credentials."""
        return {
            "provider": self.provider,
            "model": self.model,
            "modelLabel": self.model_label,
            "toolCalls": self.tool_calls,
            "modelUsed": not self.model_unavailable,
            "unavailableReason": self.unavailable_reason,
            "inputTokens": self.usage.input_tokens if self.usage else None,
            "outputTokens": self.usage.output_tokens if self.usage else None,
            "costUnits": self.usage.cost_units if self.usage else None,
            "costUnitName": self.usage.cost_unit_name if self.usage else None,
        }


def investigate(
    tools: InvestigationTools,
    config: InvestigatorConfig,
    change_description: str,
    provider: ModelProvider | None = None,
) -> AgentHypothesis:
    """Run the agent loop and return its structured hypothesis.

    If the model is unavailable the investigation continues without it: the
    deterministic analyzer is what produces findings, so the loss is the
    narrative rather than the result. The caller is told, so the UI can say so
    rather than presenting a model-free run as a model-backed one.
    """
    if provider is None:
        if not config.model_configured:
            return AgentHypothesis.unavailable(
                "No model gateway is configured, so this investigation ran "
                "deterministic checks only."
            )
        try:
            from .providers import build_provider

            provider = build_provider(config)
        except ModelUnavailable as err:
            return AgentHypothesis.unavailable(str(err))

    runner = _ToolRunner(tools, config.max_tool_result_chars)
    usage = ProviderUsage()
    conversation: list[Message] = [
        Message(
            role="user",
            content=(
                f"{change_description}\n\n"
                "Investigate this change. Reply with one JSON object: either a "
                "tool call or your final report."
            ),
        )
    ]

    for turn in range(config.max_agent_iterations):
        try:
            completion = provider.complete(
                system=SYSTEM_PROMPT,
                messages=conversation,
                max_tokens=config.max_output_tokens,
                temperature=0.0,
            )
        except ModelUnavailable as err:
            logger.warning("model unavailable on turn %d: %s", turn, err)
            return AgentHypothesis.unavailable(str(err))

        usage.record(completion)

        if usage.cost_units >= config.max_cost_units:
            # The budget is a ceiling, not a target. Stop spending and let the
            # deterministic analysis carry the investigation.
            logger.info("agent reached its cost budget after %d call(s)", usage.calls)
            return AgentHypothesis(
                provider=provider.name,
                model=provider.model,
                model_label=provider.model_label,
                tool_calls=runner.calls,
                usage=usage,
                model_unavailable=True,
                unavailable_reason=(
                    "The investigation reached its model spending budget before the "
                    "model concluded."
                ),
            )

        action = _parse_action(completion.text)

        if action is None:
            conversation += [
                Message(role="assistant", content=completion.text[:2000]),
                Message(
                    role="user",
                    content=(
                        "That was not a single JSON object. Reply with exactly one "
                        "JSON object: a tool call or your final report."
                    ),
                ),
            ]
            continue

        if action.get("done"):
            return _finalize(action, provider, runner.calls, usage)

        tool_name = str(action.get("tool", ""))
        args = action.get("args") if isinstance(action.get("args"), dict) else {}
        result = runner.run(tool_name, args)

        conversation += [
            Message(role="assistant", content=json.dumps(action)),
            Message(role="user", content=f"Tool result for {tool_name}:\n{result}"),
        ]

    # The loop is bounded; an agent that will not conclude does not get to keep
    # spending. Whatever it established is still backed by the analyzer.
    logger.info("agent reached its iteration limit without concluding")
    return AgentHypothesis(
        provider=provider.name,
        model=provider.model,
        model_label=provider.model_label,
        tool_calls=runner.calls,
        usage=usage,
        model_unavailable=True,
        unavailable_reason=(
            "The model did not reach a conclusion within its investigation budget."
        ),
    )


class _ToolRunner:
    """Dispatches a validated tool call to the sandbox-backed tools."""

    def __init__(self, tools: InvestigationTools, max_result_chars: int) -> None:
        self._tools = tools
        self._max_result_chars = max_result_chars
        self.calls = 0

    def run(self, name: str, args: dict[str, Any]) -> str:
        self.calls += 1
        try:
            return self._dispatch(name, args)[: self._max_result_chars]
        except CommandDenied as err:
            # The allowlist refused it. The model is told why and can try
            # something else; nothing was executed.
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
                limit = args.get("limit", 10)
                limit = int(limit) if str(limit).isdigit() else 10
                return json.dumps(self._tools.inspect_git_history(path, limit))
            case _:
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

    Only the declared fields are ever read. Anything else the model produced --
    including reasoning it volunteered around the JSON -- is discarded here and
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
    provider: ModelProvider,
    tool_calls: int,
    usage: ProviderUsage,
) -> AgentHypothesis:
    return AgentHypothesis(
        summary=str(action.get("summary", ""))[:400],
        explanation=str(action.get("reasoning_for_reviewer", ""))[:1200],
        suspected_secrets=[
            str(s)[:100] for s in _as_list(action.get("suspected_secrets"))
        ][:20],
        suspected_files=[
            str(s)[:400] for s in _as_list(action.get("suspected_exposed_files"))
        ][:50],
        provider=provider.name,
        model=provider.model,
        model_label=provider.model_label,
        tool_calls=tool_calls,
        usage=usage,
    )


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


__all__ = ["SYSTEM_PROMPT", "AgentHypothesis", "investigate"]
