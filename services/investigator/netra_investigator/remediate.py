"""Applying an approved remediation and verifying that it worked.

Nothing in this module runs without an approval decision having been recorded
first; the caller is responsible for that check and passes the approver's
verified identity through.

Post-fix verification re-runs the *same* deterministic analyzer against the
remediated commit. That is what makes "resolved" mean something: the check that
proved the problem is the check that must now fail to find it.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .analyzers.findings import build_verification
from .analyzers.secret_flow import VERIFIER_ID, SecretFlowAnalyzer
from .config import InvestigatorConfig
from .events import EventEmitter
from .sandbox import DockerSandbox, SandboxLimits
from .tools import InvestigationTools

logger = logging.getLogger(__name__)

BRANCH_PREFIX = "netra/remediation"


class RemediationFailed(RuntimeError):
    """The remediation could not be applied to the repository."""


@dataclass(slots=True)
class AppliedRemediation:
    branch: str
    commit_sha: str
    files_changed: list[str]


def apply_remediation(
    repo_path: Path,
    diff: str,
    *,
    investigation_reference: str,
    finding_title: str,
    approver: str,
) -> AppliedRemediation:
    """Apply the approved diff on a new branch and commit it.

    The diff applied here is byte-for-byte the diff the reviewer approved: it is
    passed through `git apply`, which refuses anything that does not apply
    cleanly, so an approved review cannot turn into a different change.
    """
    branch = f"{BRANCH_PREFIX}/{investigation_reference.lower()}"
    _git(repo_path, "checkout", "--quiet", "-B", branch)

    apply_result = subprocess.run(
        ["git", "-C", str(repo_path), "apply", "--whitespace=nowarn", "-"],
        input=diff,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if apply_result.returncode != 0:
        raise RemediationFailed(
            f"the approved patch did not apply cleanly: {apply_result.stderr.strip()}"
        )

    _git(repo_path, "add", "-A")
    message = (
        f"Fix: {finding_title}\n\n"
        f"Remediation proposed by Netra in investigation {investigation_reference} "
        f"and approved by {approver}.\n"
    )
    _git(repo_path, "commit", "--quiet", "-m", message)

    sha = _git(repo_path, "rev-parse", "HEAD").strip()
    changed = _git(repo_path, "show", "--name-only", "--format=", "HEAD").split()
    return AppliedRemediation(branch=branch, commit_sha=sha, files_changed=changed)


def verify_after_fix(
    repo_path: Path,
    emitter: EventEmitter,
    *,
    finding_id: str,
    base_sha: str,
    fixed_sha: str,
    config: InvestigatorConfig | None = None,
) -> dict[str, Any]:
    """Re-run the deterministic check against the remediated commit."""
    cfg = config or InvestigatorConfig.from_env()
    emitter.status_changed("POST_FIX_VERIFY")
    emitter.verification_started(VERIFIER_ID, finding_id)
    activity = emitter.activity_started("Re-running verification against the fix")

    limits = SandboxLimits(
        memory_mb=cfg.sandbox_memory_mb, command_timeout_s=cfg.sandbox_timeout_s
    )
    with DockerSandbox(
        repo_path, image=cfg.sandbox_image, limits=limits, checkout=fixed_sha
    ) as sandbox:
        tools = InvestigationTools(sandbox, emitter, base_sha, fixed_sha)
        report = SecretFlowAnalyzer(tools).analyze()
        duration = sum(call.duration_ms for call in tools.calls)

    result = build_verification(finding_id, report, duration_ms=duration, phase="POST_FIX")
    emitter.verification_completed(VERIFIER_ID, finding_id, result)

    if result["status"] == "REFUTED":
        emitter.activity_completed(activity, "The finding is no longer present")
        emitter.status_changed("RESOLVED")
    else:
        # The fix did not work. Saying so is the whole point of checking again.
        emitter.activity_failed(activity, "The finding is still present after the fix")
        emitter.status_changed(
            "FAILED", "Post-fix verification still finds the credential exposure."
        )
    return result


def _git(repo_path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_path), *args],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise RemediationFailed(f"git {args[0]} failed: {result.stderr.strip()}")
    return result.stdout


__all__ = ["AppliedRemediation", "RemediationFailed", "apply_remediation", "verify_after_fix"]
