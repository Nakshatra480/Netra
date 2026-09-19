"""The Fargate investigation task.

One task per investigation. It clones the repository, runs the existing
pipeline inside the task's own isolation boundary, and persists what the
pipeline established. It stops at AWAITING_APPROVAL: nothing here can
remediate, because remediation requires a human decision that arrives
separately.

Inputs arrive as environment variables because that is what ECS overrides
cleanly; secrets arrive as ECS `secrets`, which the agent resolves from Secrets
Manager and injects without them appearing in the task definition.
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from ..config import InvestigatorConfig
from ..events import EventEmitter
from ..pipeline import InvestigationRequest, run_investigation
from ..sandbox.executor import TaskSandbox
from .github import (
    AppCredentials,
    GitHubUnavailable,
    clone_repository,
    installation_token,
    mint_app_jwt,
)
from .store import InvestigationStore

logger = logging.getLogger(__name__)

#: The state this milestone ends on. Remediation is a separate, human-gated step.
TERMINAL_STATUS = "AWAITING_APPROVAL"


class TaskInputError(ValueError):
    """The task was started without the inputs it needs."""


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise TaskInputError(f"{name} is required")
    return value


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format='{"level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}',
    )
    _ = argv

    # NETRA_TASK_MODE=remediate routes to the remediation path instead of the
    # investigation pipeline. The ENTRYPOINT stays unchanged; the Lambda sets
    # this env var in the container override to select the mode.
    task_mode = os.environ.get("NETRA_TASK_MODE", "investigate").strip().lower()
    if task_mode == "remediate":
        from ..__main__ import _remediate_from_env
        from ..config import InvestigatorConfig
        return _remediate_from_env(InvestigatorConfig.from_env())

    try:
        investigation_id = _required("NETRA_INVESTIGATION_ID")
        repository = _required("NETRA_REPOSITORY")
        head_sha = _required("NETRA_HEAD_SHA")
        table_name = _required("NETRA_TABLE_NAME")
        installation = int(_required("NETRA_INSTALLATION_ID"))
    except (TaskInputError, ValueError) as err:
        logger.error("invalid task input: %s", err)
        return 2

    base_sha = os.environ.get("NETRA_BASE_SHA", "").strip() or None
    title = os.environ.get("NETRA_CHANGE_TITLE", "").strip() or "Change under investigation"
    region = os.environ.get("AWS_REGION", "eu-north-1")

    store = InvestigationStore(table_name, region=region)
    config = InvestigatorConfig.from_env()

    # Events are persisted as they happen, so an investigation that dies
    # mid-flight still shows how far it got rather than vanishing.
    collected: list[dict[str, Any]] = []

    def sink(event: dict[str, Any]) -> None:
        collected.append(event)
        if len(collected) % 25 == 0:
            store.put_events(investigation_id, collected[-25:])

    emitter = EventEmitter(investigation_id, sink)

    workdir = Path(tempfile.mkdtemp(prefix="netra-clone-"))
    try:
        store.set_status(investigation_id, "PREPARING")
        activity = emitter.activity_started(f"Cloning {repository}")

        try:
            credentials = AppCredentials.from_secret(_required("NETRA_GITHUB_APP_SECRET"))
            token = installation_token(mint_app_jwt(credentials), installation)
            repo_path = clone_repository(
                repository,
                token,
                workdir / "repo",
                commits=(head_sha, base_sha or ""),
            )
        except (GitHubUnavailable, TaskInputError) as err:
            emitter.activity_failed(activity, f"Could not fetch the repository: {err}")
            return _fail(store, emitter, investigation_id, collected, str(err))

        # Without a base commit there is no change to investigate, only a
        # snapshot. Say so rather than inventing a comparison.
        if not base_sha:
            base_sha = _first_parent(repo_path, head_sha)
            if not base_sha:
                message = "The change has no parent commit to compare against."
                emitter.activity_failed(activity, message)
                return _fail(store, emitter, investigation_id, collected, message)

        emitter.activity_completed(activity, f"Repository ready at {head_sha[:12]}")

        outcome = run_investigation(
            InvestigationRequest(
                investigation_id=investigation_id,
                repo_path=repo_path,
                base_sha=base_sha,
                head_sha=head_sha,
                repository_full_name=repository,
                change_title=title,
            ),
            emitter,
            config,
            # On Fargate the task is the boundary; there is no image to start.
            sandbox_factory=lambda path, _image, limits, checkout: TaskSandbox(
                path, limits=limits, checkout=checkout
            ),
        )

        _persist(store, investigation_id, outcome, collected)
        logger.info(
            "investigation finished",
            extra={"investigation": investigation_id, "status": outcome.status},
        )
        return 0 if outcome.status != "FAILED" else 1

    except Exception as err:  # noqa: BLE001 - the task must never end silently
        logger.exception("investigation task failed")
        return _fail(store, emitter, investigation_id, collected, str(err))
    finally:
        import shutil

        shutil.rmtree(workdir, ignore_errors=True)


def _first_parent(repo: Path, head_sha: str) -> str | None:
    import subprocess

    result = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", f"{head_sha}^"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def _persist(
    store: InvestigationStore,
    investigation_id: str,
    outcome: Any,
    events: list[dict[str, Any]],
) -> None:
    """Write everything the investigation established."""
    store.put_events(investigation_id, events)

    if outcome.finding:
        store.put_findings(investigation_id, [outcome.finding])
    if outcome.evidence:
        store.put_evidence(investigation_id, outcome.evidence)
    if outcome.verifications:
        store.put_verifications(investigation_id, outcome.verifications)
    if outcome.graph:
        store.put_graph(investigation_id, outcome.graph)
    if outcome.remediation:
        store.put_remediation(investigation_id, outcome.remediation)
    if outcome.action:
        store.put_action(investigation_id, outcome.action)

    store.set_status(
        investigation_id,
        outcome.status,
        failure_reason=outcome.failure_reason,
        extra={
            "severity": outcome.severity,
            "summary": outcome.summary,
            "modelProvenance": outcome.model_metadata or {},
            "findingCount": 1 if outcome.finding else 0,
            "evidenceCount": len(outcome.evidence),
        },
    )


def _fail(
    store: InvestigationStore,
    emitter: EventEmitter,
    investigation_id: str,
    events: list[dict[str, Any]],
    reason: str,
) -> int:
    emitter.status_changed("FAILED", reason[:500])
    try:
        store.put_events(investigation_id, events)
        store.set_status(investigation_id, "FAILED", failure_reason=reason[:500])
    except Exception:  # noqa: BLE001 - already failing; do not mask the cause
        logger.exception("could not record the failure")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
