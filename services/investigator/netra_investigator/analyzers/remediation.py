"""Generation of the proposed remediation.

The patch is computed, not written by a language model. For a change that
introduced a credential exposure, the safe and reviewable remedy is to undo
exactly the part of the change that causes it: the files on the traced exposure
path are restored to their pre-change contents, and every other part of the
change is left untouched.

This keeps the proposal bounded (Netra can only revert lines this change added),
verifiable (post-fix analysis re-runs the same check), and honest (the diff the
reviewer approves is the diff that will be committed).
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass
from typing import Any

from ..tools import InvestigationTools
from .secret_flow import SecretFlowReport

STRATEGY_ID = "revert-client-credential-exposure-v1"


@dataclass(slots=True)
class FileEdit:
    """The intended end state of one file."""

    path: str
    #: None means the file should be deleted (the change created it).
    new_content: str | None
    old_content: str


@dataclass(slots=True)
class RemediationPlan:
    """A remediation proposal, ready for human review."""

    strategy: str
    title: str
    rationale: str
    diff: str
    affected_files: list[str]
    expected_impact: str
    edits: list[FileEdit]

    def to_payload(self, finding_id: str) -> dict[str, Any]:
        return {
            "findingId": finding_id,
            "strategy": self.strategy,
            "title": self.title,
            "rationale": self.rationale,
            "diff": self.diff,
            "affectedFiles": self.affected_files,
            "expectedImpact": self.expected_impact,
        }


class RemediationUnavailable(Exception):
    """No bounded, reviewable remediation could be generated."""


def plan_remediation(
    tools: InvestigationTools,
    report: SecretFlowReport,
    base_sha: str,
) -> RemediationPlan:
    """Build the patch that removes the proven exposure.

    Only files that this change touched *and* that participate in the exposure
    are eligible, so the proposal can never rewrite unrelated code.
    """
    if not report.exposed:
        raise RemediationUnavailable("nothing was proven to be exposed")

    exposure_files: set[str] = {p.reference.file for p in report.exposure_paths}
    for path in report.exposure_paths:
        exposure_files.update(path.hops)
    if report.inlined_by_bundler and report.surface and report.surface.config_file:
        exposure_files.add(report.surface.config_file)

    targets = sorted(exposure_files & set(report.changed_files))
    if not targets:
        raise RemediationUnavailable(
            "the exposure is not caused by files this change modified"
        )

    edits: list[FileEdit] = []
    for path in targets:
        current_lines = tools.read_file(path)
        baseline_lines = tools.read_file_at_commit(base_sha, path)
        current = "\n".join(current_lines) + "\n" if current_lines else ""
        if baseline_lines is None:
            # The change created this file; removing the exposure removes it.
            edits.append(FileEdit(path=path, new_content=None, old_content=current))
        else:
            baseline = "\n".join(baseline_lines) + "\n"
            if baseline != current:
                edits.append(FileEdit(path=path, new_content=baseline, old_content=current))

    if not edits:
        raise RemediationUnavailable("no file differs from its pre-change contents")

    diff = _render_diff(edits)
    secrets = ", ".join(report.exposed_secrets)
    return RemediationPlan(
        strategy=STRATEGY_ID,
        title=f"Remove {secrets} from the browser bundle",
        rationale=(
            f"{secrets} is reachable from the browser entry point and is inlined "
            "into the public bundle at build time. Reverting the client-side "
            "portion of this change removes the exposure without touching the "
            "rest of the work in this pull request."
        ),
        diff=diff,
        affected_files=[e.path for e in edits],
        expected_impact=(
            "Browser-side receipt upload is removed along with the credential. "
            "The upload feature needs a server-issued presigned URL before it "
            "can ship; the rest of the change is unaffected."
        ),
        edits=edits,
    )


def _render_diff(edits: list[FileEdit]) -> str:
    """Render the plan as a unified diff, in the form git would produce."""
    chunks: list[str] = []
    for edit in edits:
        old_lines = edit.old_content.splitlines(keepends=True)
        new_lines = (edit.new_content or "").splitlines(keepends=True)
        to_path = "/dev/null" if edit.new_content is None else f"b/{edit.path}"
        chunks.append(f"diff --git a/{edit.path} b/{edit.path}")
        if edit.new_content is None:
            chunks.append("deleted file mode 100644")
        body = difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=f"a/{edit.path}",
            tofile=to_path,
            n=3,
        )
        chunks.append("".join(body).rstrip("\n"))
    return "\n".join(chunks) + "\n"


__all__ = [
    "STRATEGY_ID",
    "FileEdit",
    "RemediationPlan",
    "RemediationUnavailable",
    "plan_remediation",
]
