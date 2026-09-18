"""Turning analysis results into findings, evidence and verification records.

The separation enforced here is the product's trust model:

* the analyzer produces facts about the repository;
* this module turns those facts into evidence and a verification result;
* a language model may only *describe* what is already proven.

Confidence is derived from verification status. It is never a number the model
chose, and `VERIFIED` is only ever set by deterministic code.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ..events import new_id
from .secret_flow import VERIFIER_ID, SecretFlowReport

#: Confidence implied by each verification status.
CONFIDENCE_BY_STATUS = {
    "VERIFIED": 0.95,
    "UNVERIFIED": 0.4,
    "INCONCLUSIVE": 0.25,
    "REFUTED": 0.05,
}


#: How damaging each kind of credential is if published. Used to decide which
#: credential a finding is titled after when a change exposes several.
_SENSITIVITY = (
    ("SECRET_ACCESS_KEY", 5),
    ("PRIVATE_KEY", 5),
    ("CLIENT_SECRET", 4),
    ("SESSION_SECRET", 4),
    ("SIGNING_KEY", 4),
    ("PASSWORD", 4),
    ("SECRET", 4),
    ("AUTH_TOKEN", 3),
    ("API_KEY", 3),
    ("ACCESS_KEY_ID", 1),
)


def _sensitivity(name: str) -> int:
    for suffix, weight in _SENSITIVITY:
        if name.endswith(suffix):
            return weight
    return 2


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def build_finding(
    investigation_id: str,
    report: SecretFlowReport,
    *,
    finding_id: str | None = None,
) -> dict[str, Any] | None:
    """Create the finding for a proven exposure, or None when nothing was proven."""
    if not report.exposed:
        return None

    secrets = report.exposed_secrets
    # The headline names the most sensitive credential involved: an identifier
    # is embarrassing, a signing secret is an incident.
    subject = max(secrets, key=_sensitivity)
    affected = sorted(
        {p.reference.file for p in report.exposure_paths}
        | ({report.surface.config_file} if report.surface and report.inlined_by_bundler else set())
    )
    affected = [f for f in affected if f]

    secret_list = ", ".join(secrets)
    title = (
        f"{subject} reaches the browser bundle"
        if len(secrets) == 1
        else f"{len(secrets)} credentials reach the browser bundle"
    )

    description = (
        f"This change routes {secret_list} into code that is compiled into the "
        "public browser bundle. Anything in that bundle is downloadable by every "
        "visitor, so the credential would be published the next time the client "
        "is built and deployed."
    )

    impact_parts: list[str] = []
    if report.inlined_by_bundler:
        config = report.surface.config_file if report.surface else "the bundler config"
        impact_parts.append(
            f"{config} substitutes the credential's value at build time, so it is "
            "written into the shipped JavaScript as a literal string."
        )
    if report.exposure_paths:
        shortest = min(report.exposure_paths, key=lambda p: len(p.hops))
        impact_parts.append(
            "The credential is reachable from the browser entry point "
            f"{shortest.hops[0]} through {len(shortest.hops) - 1} import"
            f"{'' if len(shortest.hops) - 1 == 1 else 's'}."
        )
    impact = " ".join(impact_parts)

    return {
        "id": finding_id or new_id("fnd"),
        "investigationId": investigation_id,
        "category": "CREDENTIAL_EXPOSURE",
        "severity": "CRITICAL" if report.inlined_by_bundler else "HIGH",
        "title": title,
        "description": description,
        "impact": impact,
        "subject": subject,
        "affectedFiles": affected,
        "confidence": CONFIDENCE_BY_STATUS["VERIFIED"],
        "verificationStatus": "VERIFIED",
        "recommendation": (
            "Remove the credential from the client configuration and the bundler "
            "define block, and move receipt uploads behind a server-issued "
            "presigned URL so the browser never holds long-lived credentials."
        ),
        "remediationAvailable": True,
        "status": "OPEN",
        "createdAt": _now(),
    }


def build_evidence(
    finding_id: str,
    report: SecretFlowReport,
    *,
    command_for: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Create the evidence chain supporting a finding.

    Each item records where the fact came from: the analyzer that produced it
    and, where applicable, the exact command whose output contained it.
    """
    commands = command_for or {}
    evidence: list[dict[str, Any]] = []

    def add(**kwargs: Any) -> None:
        evidence.append(
            {
                "id": new_id("evd"),
                "findingId": finding_id,
                "endLine": None,
                "verificationStatus": "VERIFIED",
                "producedBy": VERIFIER_ID,
                "producedByCommand": None,
                "createdAt": _now(),
                **kwargs,
            }
        )

    # 1. The change itself introduced the credential read.
    for reference in report.secrets_introduced:
        add(
            kind="DIFF_HUNK",
            file=reference.file,
            line=reference.line,
            snippet=reference.text,
            relationship=f"This change added a read of {reference.secret}.",
            producedByCommand=commands.get("inspect_diff"),
        )

    # 2. The bundler publishes the value.
    if report.inlined_by_bundler and report.surface and report.surface.config_file:
        add(
            kind="CONFIG_ENTRY",
            file=report.surface.config_file,
            line=None,
            snippet=f"define: {{ 'process.env.{report.inlined_by_bundler[0]}': ... }}",
            relationship=(
                "The bundler substitutes this credential's value into the browser "
                "bundle at build time."
            ),
            producedByCommand=commands.get("read_file"),
        )

    # 3. The traced route from the browser entry point to the credential read.
    seen_paths: set[tuple[str, ...]] = set()
    for path in report.exposure_paths:
        key = (path.secret, *path.hops)
        if key in seen_paths:
            continue
        seen_paths.add(key)
        add(
            kind="REFERENCE_PATH",
            file=path.reference.file,
            line=path.reference.line,
            snippet=path.reference.text,
            relationship=(
                f"Reachable from the browser entry point via {' -> '.join(path.hops)}."
            ),
            producedByCommand=commands.get("find_references"),
        )

    return evidence


def build_verification(
    finding_id: str,
    report: SecretFlowReport,
    *,
    duration_ms: int,
    phase: str = "PRE_FIX",
    command: str | None = None,
) -> dict[str, Any]:
    """Record the deterministic check's verdict.

    `VERIFIED` means a path was traced. `REFUTED` means the check ran and found
    no such path -- which, after remediation, is what closes the investigation.
    """
    if report.exposed:
        status = "VERIFIED"
        claim = f"{', '.join(report.exposed_secrets)} reaches the browser bundle."
        detail_parts = []
        if report.inlined_by_bundler:
            detail_parts.append(
                f"Bundler inlines {', '.join(report.inlined_by_bundler)} at build time."
            )
        for path in report.exposure_paths[:5]:
            detail_parts.append(f"{path.secret}: {' -> '.join(path.hops)}")
        detail = " ".join(detail_parts)
    else:
        status = "REFUTED"
        claim = "No credential reaches the browser bundle."
        detail = (
            "The import graph was walked from every browser entry point and no "
            "reachable module reads a credential; the bundler no longer "
            "substitutes one."
        )

    return {
        "id": new_id("vrf"),
        "findingId": finding_id,
        "verifier": VERIFIER_ID,
        "status": status,
        "claim": claim,
        "detail": detail,
        "command": command,
        "durationMs": duration_ms,
        "phase": phase,
        "createdAt": _now(),
    }


__all__ = ["CONFIDENCE_BY_STATUS", "build_evidence", "build_finding", "build_verification"]
