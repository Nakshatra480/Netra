"""The investigation agent: Strands over Amazon Bedrock.

The agent's job is to *investigate and explain*, never to decide what is true.
It is given the same structured tools the analyzer uses, so anything it looks at
is a real repository fact obtained through the sandbox. Its output is a short,
reviewer-facing narrative plus the hypotheses it wants checked.

Three rules are enforced here rather than requested in the prompt:

* the agent cannot execute a command -- it can only call a tool;
* the agent's claims are never marked verified;
* the agent's private reasoning is never emitted or stored. Only the final
  structured summary leaves this module.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from .config import InvestigatorConfig
from .tools import InvestigationTools

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are Netra's change investigator. You examine a single code change in a
repository and explain what it could cause.

You have read-only analysis tools. Use them to establish facts. You must not
claim anything you have not observed through a tool.

Your focus is credential exposure: a change that causes a secret, key, token or
password to reach a context that publishes it, such as a browser bundle.

Rules:
- Never state that something is "verified" or "confirmed". A separate
  deterministic checker decides that, not you.
- Never invent a file path, line number or identifier.
- Be concise. A reviewer reads your summary in ten seconds.

When you have finished investigating, reply with only a JSON object:
{
  "summary": "one sentence naming the consequence of this change",
  "reasoning_for_reviewer": "two or three sentences of plain explanation",
  "suspected_secrets": ["ENV_VAR_NAME"],
  "suspected_exposed_files": ["path/to/file"]
}
"""


@dataclass(slots=True)
class AgentHypothesis:
    """What the model believes, before anything has been checked."""

    summary: str
    explanation: str
    suspected_secrets: list[str]
    suspected_files: list[str]
    #: True when the model was unavailable and the pipeline proceeded without it.
    model_unavailable: bool = False
    unavailable_reason: str | None = None

    @classmethod
    def unavailable(cls, reason: str) -> AgentHypothesis:
        return cls(
            summary="",
            explanation="",
            suspected_secrets=[],
            suspected_files=[],
            model_unavailable=True,
            unavailable_reason=reason,
        )


class BedrockUnavailable(RuntimeError):
    """Bedrock could not be reached or the model is not accessible."""


def build_agent(tools: InvestigationTools, config: InvestigatorConfig):
    """Construct a Strands agent bound to this investigation's tools."""
    from strands import Agent, tool
    from strands.models import BedrockModel

    @tool
    def inspect_diff(path: str = "") -> str:
        """Show the unified diff of the change under investigation.

        Args:
            path: optional repository-relative path to limit the diff to.
        """
        return tools.inspect_diff(path or None)[:20_000]

    @tool
    def list_changed_files() -> str:
        """List the files this change added, modified or deleted."""
        return json.dumps(
            [{"path": c.path, "changeType": c.change_type} for c in tools.changed_files()]
        )

    @tool
    def search_repository(query: str, path: str = ".") -> str:
        """Search the repository for a literal string.

        Args:
            query: the exact text to look for.
            path: optional repository-relative directory to search in.
        """
        return json.dumps(
            [{"file": m.file, "line": m.line, "text": m.text} for m in
             tools.search_repository(query, path)]
        )

    @tool
    def find_references(symbol: str, path: str = ".") -> str:
        """Find whole-word references to an identifier.

        Args:
            symbol: the identifier, such as an environment variable name.
            path: optional repository-relative directory to search in.
        """
        return json.dumps(
            [{"file": m.file, "line": m.line, "text": m.text} for m in
             tools.find_references(symbol, path)]
        )

    @tool
    def read_file(path: str) -> str:
        """Read a repository file.

        Args:
            path: repository-relative path of the file to read.
        """
        return "\n".join(tools.read_file(path))[:20_000]

    @tool
    def list_files(path: str = ".") -> str:
        """List tracked files under a path.

        Args:
            path: optional repository-relative directory.
        """
        return json.dumps(tools.list_files(path)[:300])

    @tool
    def inspect_git_history(path: str = "", limit: int = 10) -> str:
        """Show recent commits, optionally for one path.

        Args:
            path: optional repository-relative path.
            limit: how many commits to show, at most 50.
        """
        return json.dumps(tools.inspect_git_history(path or None, limit))

    model = BedrockModel(model_id=config.bedrock_model_id, region_name=config.aws_region)
    return Agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=[
            inspect_diff,
            list_changed_files,
            search_repository,
            find_references,
            read_file,
            list_files,
            inspect_git_history,
        ],
    )


def investigate(
    tools: InvestigationTools,
    config: InvestigatorConfig,
    change_description: str,
) -> AgentHypothesis:
    """Run the agent and return its structured hypothesis.

    If Bedrock is unavailable the investigation continues without the model:
    the deterministic analyzer is what produces findings, so the loss is the
    narrative rather than the result. The caller is told so it can say so in
    the UI rather than presenting a model-free run as a model-backed one.
    """
    try:
        agent = build_agent(tools, config)
    except Exception as err:  # noqa: BLE001 - surfaced to the user, never swallowed
        logger.warning("could not construct the agent: %s", err)
        return AgentHypothesis.unavailable(str(err))

    prompt = (
        f"{change_description}\n\n"
        "Investigate this change. Establish the facts with your tools, then "
        "reply with only the JSON object described in your instructions."
    )

    try:
        result = agent(prompt)
    except Exception as err:  # noqa: BLE001
        logger.warning("bedrock invocation failed: %s", err)
        return AgentHypothesis.unavailable(_describe_failure(err))

    return _parse(str(result))


def _describe_failure(err: Exception) -> str:
    """A short, non-sensitive description of why the model could not be used."""
    text = str(err)
    if "AccessDenied" in text or "being verified" in text:
        return "Amazon Bedrock model access is not yet available for this account."
    if "ThrottlingException" in text:
        return "Amazon Bedrock throttled the request."
    if "ExpiredToken" in text or "credentials" in text.lower():
        return "AWS credentials were unavailable to the investigator."
    return "Amazon Bedrock could not be reached."


_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def _parse(raw: str) -> AgentHypothesis:
    """Extract the structured hypothesis from the agent's reply.

    Only the declared fields are read. Anything else the model produced --
    including any reasoning it volunteered -- is discarded here and never
    reaches storage or the UI.
    """
    match = _JSON_BLOCK.search(raw)
    if not match:
        return AgentHypothesis.unavailable("the model did not return a usable result")
    try:
        data: dict[str, Any] = json.loads(match.group(0))
    except json.JSONDecodeError:
        return AgentHypothesis.unavailable("the model did not return a usable result")

    return AgentHypothesis(
        summary=str(data.get("summary", ""))[:400],
        explanation=str(data.get("reasoning_for_reviewer", ""))[:1200],
        suspected_secrets=[str(s)[:100] for s in data.get("suspected_secrets", [])][:20],
        suspected_files=[str(s)[:400] for s in data.get("suspected_exposed_files", [])][:50],
    )


__all__ = ["AgentHypothesis", "BedrockUnavailable", "build_agent", "investigate"]
