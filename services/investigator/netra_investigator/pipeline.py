"""The investigation pipeline.

Drives one investigation through its lifecycle, emitting an event for every
real step. The pipeline stops at AWAITING_APPROVAL: nothing here can remediate,
because remediation requires a human decision that arrives as a separate call.

    prepare -> investigate -> collect evidence -> verify -> impact -> recommend
             -> [human approval] -> remediate -> post-fix verify -> resolved
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .agent import AgentHypothesis, investigate
from .analyzers.findings import build_evidence, build_finding, build_verification
from .analyzers.graph import build_graph
from .analyzers.remediation import RemediationPlan, RemediationUnavailable, plan_remediation
from .analyzers.secret_flow import SecretFlowAnalyzer, SecretFlowReport
from .config import InvestigatorConfig
from .context import prefilter
from .events import EventEmitter, new_id
from .sandbox import DockerSandbox, SandboxError, SandboxLimits
from .tools import InvestigationTools, ToolCallRecord

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class InvestigationRequest:
    investigation_id: str
    repo_path: Path
    base_sha: str
    head_sha: str
    repository_full_name: str
    change_title: str


@dataclass(slots=True)
class InvestigationOutcome:
    """Everything the investigation established, for persistence and display."""

    status: str
    summary: str | None = None
    severity: str | None = None
    finding: dict[str, Any] | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)
    verifications: list[dict[str, Any]] = field(default_factory=list)
    graph: dict[str, Any] | None = None
    remediation: dict[str, Any] | None = None
    action: dict[str, Any] | None = None
    failure_reason: str | None = None
    model_used: bool = False
    #: Which provider and model produced the narrative. Never contains secrets.
    model_metadata: dict[str, Any] = field(default_factory=dict)


def run_investigation(
    request: InvestigationRequest,
    emitter: EventEmitter,
    config: InvestigatorConfig | None = None,
) -> InvestigationOutcome:
    """Run an investigation up to the point a human must decide."""
    cfg = config or InvestigatorConfig.from_env()
    emitter.status_changed("CREATED")

    try:
        return _run(request, emitter, cfg)
    except SandboxError as err:
        reason = f"The analysis sandbox could not be prepared: {err}"
        logger.error("sandbox failure", extra={"investigation": request.investigation_id})
        emitter.status_changed("FAILED", reason)
        return InvestigationOutcome(status="FAILED", failure_reason=reason)
    except Exception as err:  # noqa: BLE001 - the UI must never hang on "investigating"
        reason = f"The investigation stopped unexpectedly: {err}"
        logger.exception("investigation failed", extra={"investigation": request.investigation_id})
        emitter.status_changed("FAILED", reason)
        return InvestigationOutcome(status="FAILED", failure_reason=reason)


def _run(
    request: InvestigationRequest,
    emitter: EventEmitter,
    cfg: InvestigatorConfig,
) -> InvestigationOutcome:
    emitter.status_changed("PREPARING")
    activity = emitter.activity_started("Preparing an isolated analysis workspace")

    limits = SandboxLimits(
        memory_mb=cfg.sandbox_memory_mb, command_timeout_s=cfg.sandbox_timeout_s
    )
    with DockerSandbox(
        request.repo_path, image=cfg.sandbox_image, limits=limits, checkout=request.head_sha
    ) as sandbox:
        emitter.activity_completed(activity, "Workspace ready: no network, read-only, non-root")
        tools = InvestigationTools(sandbox, emitter, request.base_sha, request.head_sha)

        # Within INVESTIGATING, deterministic analysis runs before the model:
        # it decides what is true, and its compact result is the only context
        # the model is given. That ordering is the trust model and the token
        # strategy at once.
        report, finding, hypothesis = _investigate_phase(request, emitter, tools, cfg)
        evidence = _evidence_phase(emitter, tools, report, finding)
        verification = _verify_phase(emitter, tools, report, finding)
        graph = _impact_phase(emitter, report, finding, evidence)
        outcome = _recommend_phase(
            request, emitter, tools, report, finding, hypothesis, verification, graph, evidence
        )

    return outcome


def _investigate_phase(
    request: InvestigationRequest,
    emitter: EventEmitter,
    tools: InvestigationTools,
    cfg: InvestigatorConfig,
) -> tuple[SecretFlowReport, dict[str, Any] | None, AgentHypothesis]:
    """Establish the facts, then ask a model what they mean."""
    emitter.status_changed("INVESTIGATING")

    trace = emitter.activity_started("Tracing credential flow through the repository")
    report = SecretFlowAnalyzer(tools).analyze()
    finding = build_finding(request.investigation_id, report)

    if finding is None:
        emitter.activity_completed(trace, "No credential reaches a published context")
    else:
        emitter.activity_completed(
            trace,
            f"Traced {len(report.exposure_paths)} exposure path(s) for "
            f"{', '.join(report.exposed_secrets)}",
        )

    activity = emitter.activity_started("Interpreting the change")

    description = (
        f"Repository: {request.repository_full_name}\n"
        f"Change: {request.change_title}\n"
        f"Base commit: {request.base_sha[:12]}\n"
        f"Head commit: {request.head_sha[:12]}"
    )

    # The prefilter decides whether a model is worth invoking at all, and how
    # capable a model the change deserves.
    decision = prefilter(
        changed_file_count=len(report.changed_files),
        secrets_introduced=len(report.secrets_introduced),
        exposure_paths=len(report.exposure_paths),
        bundler_inlined=len(report.inlined_by_bundler),
    )
    hypothesis = investigate(
        tools,
        cfg,
        description,
        findings_context=_findings_context(report, finding),
        decision=decision,
    )

    if hypothesis.model_unavailable:
        # Said plainly rather than hidden: the user should know which parts of
        # this investigation the model contributed to.
        emitter.activity_failed(
            activity,
            f"Model investigation unavailable -- {hypothesis.unavailable_reason} "
            "Continuing with deterministic analysis only.",
        )
    else:
        emitter.activity_completed(
            activity,
            f"{hypothesis.provider} · {hypothesis.model_label} interpreted the change "
            f"({hypothesis.metadata.get('estimatedTokens', 0):,} context tokens, "
            f"{hypothesis.metadata.get('calls', 0)} model turn"
            f"{'' if hypothesis.metadata.get('calls') == 1 else 's'})",
        )
    return report, finding, hypothesis


def _findings_context(report: SecretFlowReport, finding: dict[str, Any] | None) -> str:
    """The compact, structured result of deterministic analysis.

    This is what replaces sending the repository: a few hundred tokens of
    established fact rather than thousands of tokens of source.
    """
    if finding is None:
        return "Deterministic analysis found no credential flow."

    lines = [
        f"Finding: {finding['title']}",
        f"Severity (deterministic): {finding['severity']}",
        f"Credentials involved: {', '.join(report.exposed_secrets)}",
        f"Changed files: {', '.join(report.changed_files[:12])}",
    ]
    if report.inlined_by_bundler and report.surface:
        lines.append(
            f"Bundler {report.surface.config_file} inlines: "
            f"{', '.join(report.inlined_by_bundler)}"
        )
    for path in report.exposure_paths[:5]:
        lines.append(f"Traced path: {' -> '.join(path.hops)} reads {path.secret}")
    return "\n".join(lines)


def _evidence_phase(
    emitter: EventEmitter,
    tools: InvestigationTools,
    report: SecretFlowReport,
    finding: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Publish the evidence chain supporting the finding."""
    emitter.status_changed("EVIDENCE_COLLECTION")
    if finding is None:
        return []

    activity = emitter.activity_started("Collecting evidence")
    emitter.finding_detected(finding)

    evidence = build_evidence(finding["id"], report, command_for=_commands_by_tool(tools.calls))
    for item in evidence:
        emitter.evidence_found(item)

    emitter.activity_completed(
        activity, f"{len(evidence)} evidence item(s) recorded"
    )
    return evidence


def _verify_phase(
    emitter: EventEmitter,
    tools: InvestigationTools,
    report: SecretFlowReport,
    finding: dict[str, Any] | None,
) -> dict[str, Any] | None:
    emitter.status_changed("VERIFYING")
    if finding is None:
        return None

    from .analyzers.secret_flow import VERIFIER_ID

    emitter.verification_started(VERIFIER_ID, finding["id"])
    activity = emitter.activity_started("Running deterministic verification")

    # The check is deliberately independent of the model: it re-derives the
    # exposure from the repository, so a model claim can never become a verdict.
    duration = sum(call.duration_ms for call in tools.calls)
    result = build_verification(
        finding["id"],
        report,
        duration_ms=duration,
        phase="PRE_FIX",
        command=_commands_by_tool(tools.calls).get("find_references"),
    )
    emitter.verification_completed(VERIFIER_ID, finding["id"], result)
    emitter.activity_completed(activity, f"Verification result: {result['status']}")
    return result


def _impact_phase(
    emitter: EventEmitter,
    report: SecretFlowReport,
    finding: dict[str, Any] | None,
    evidence: list[dict[str, Any]],
) -> dict[str, Any]:
    emitter.status_changed("IMPACT_ANALYSIS")
    activity = emitter.activity_started("Building the blast radius")
    graph = build_graph(report, finding, evidence)
    affected = sum(1 for n in graph["nodes"] if n["onAffectedPath"])
    emitter.activity_completed(
        activity, f"{len(graph['nodes'])} artifacts mapped, {affected} on the affected path"
    )
    emitter.graph_updated(graph)
    return graph


def _recommend_phase(
    request: InvestigationRequest,
    emitter: EventEmitter,
    tools: InvestigationTools,
    report: SecretFlowReport,
    finding: dict[str, Any] | None,
    hypothesis: AgentHypothesis,
    verification: dict[str, Any] | None,
    graph: dict[str, Any],
    evidence: list[dict[str, Any]],
) -> InvestigationOutcome:
    emitter.status_changed("RECOMMENDATION")

    if finding is None:
        summary = "No credential exposure was found in this change."
        emitter.status_changed("RESOLVED")
        return InvestigationOutcome(
            status="RESOLVED",
            summary=summary,
            severity="INFO",
            graph=graph,
            model_used=not hypothesis.model_unavailable,
            model_metadata=hypothesis.to_metadata(),
        )

    summary = _summary_for(finding, hypothesis)
    activity = emitter.activity_started("Preparing a remediation for review")

    try:
        plan: RemediationPlan = plan_remediation(tools, report, request.base_sha)
    except RemediationUnavailable as err:
        # An honest dead end: the finding stands, but Netra will not invent a fix.
        emitter.activity_failed(activity, f"No bounded remediation available: {err}")
        finding["remediationAvailable"] = False
        emitter.status_changed("RESOLVED")
        return InvestigationOutcome(
            status="RESOLVED",
            summary=summary,
            severity=finding["severity"],
            finding=finding,
            evidence=evidence,
            verifications=[verification] if verification else [],
            graph=graph,
            model_used=not hypothesis.model_unavailable,
            model_metadata=hypothesis.to_metadata(),
        )

    emitter.activity_completed(
        activity, f"Remediation prepared across {len(plan.affected_files)} file(s)"
    )

    action = {
        "id": new_id("act"),
        "investigationId": request.investigation_id,
        "type": "CREATE_REMEDIATION_PR",
        "status": "PENDING",
        "requestedBy": "netra-investigator",
        "approvedBy": None,
        "decisionNote": None,
        "resultUrl": None,
        "createdAt": finding["createdAt"],
        "decidedAt": None,
    }
    remediation = plan.to_payload(finding["id"])
    emitter.remediation_proposed(remediation, action)
    emitter.status_changed("AWAITING_APPROVAL")

    return InvestigationOutcome(
        status="AWAITING_APPROVAL",
        summary=summary,
        severity=finding["severity"],
        finding=finding,
        evidence=evidence,
        verifications=[verification] if verification else [],
        graph=graph,
        remediation=remediation,
        action=action,
        model_used=not hypothesis.model_unavailable,
        model_metadata=hypothesis.to_metadata(),
    )


def _summary_for(finding: dict[str, Any], hypothesis: AgentHypothesis) -> str:
    """Prefer the model's sentence, but only when it agrees with what was proven.

    The deterministic description is the fallback, so an unavailable or
    off-target model degrades the prose rather than the conclusion.
    """
    candidate = hypothesis.summary.strip()
    if not candidate:
        return finding["description"]
    if finding["subject"].lower() not in candidate.lower():
        return finding["description"]
    return candidate


def _commands_by_tool(calls: list[ToolCallRecord]) -> dict[str, str]:
    """Most recent command per tool, so evidence can cite how it was obtained."""
    return {call.tool: call.command for call in calls}


__all__ = [
    "InvestigationOutcome",
    "InvestigationRequest",
    "run_investigation",
]
