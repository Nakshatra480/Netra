"""Command-line entry point for the investigator.

The API service runs this as a subprocess during local development and as a
Lambda-packaged module in AWS. Events are written to stdout as NDJSON so the
caller can republish them to connected clients as they happen; the final
outcome is written last as a single `result` line.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import asdict
from pathlib import Path

from .config import InvestigatorConfig
from .events import EventEmitter, ndjson_sink
from .pipeline import InvestigationRequest, run_investigation
from .remediate import apply_remediation, push_and_create_pr, verify_after_fix
from .aws.github import AppCredentials, GitHubUnavailable


def _configure_logging() -> None:
    """Log to stderr so stdout carries only the event stream."""
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format='{"level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}',
    )


def main(argv: list[str] | None = None) -> int:
    _configure_logging()
    parser = argparse.ArgumentParser(prog="netra-investigate")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="investigate a change")
    run.add_argument("--investigation-id", required=True)
    run.add_argument("--repo", required=True, type=Path)
    run.add_argument("--base-sha", required=True)
    run.add_argument("--head-sha", required=True)
    run.add_argument("--repository", required=True)
    run.add_argument("--title", default="")

    sub.add_parser("doctor", help="report model provider availability")
    sub.add_parser("smoke", help="make one minimal real model request")

    fix = sub.add_parser("remediate", help="apply an approved remediation and re-verify")
    fix.add_argument("--investigation-id", required=True)
    fix.add_argument("--reference", required=True)
    fix.add_argument("--repo", required=True, type=Path)
    fix.add_argument("--base-sha", required=True)
    fix.add_argument("--finding-id", required=True)
    fix.add_argument("--finding-title", required=True)
    fix.add_argument("--approver", required=True)
    fix.add_argument(
        "--diff-file",
        required=True,
        type=Path,
        help="path to the approved diff; passed as a file so it is never shell-quoted",
    )
    fix.add_argument(
        "--installation-id",
        type=int,
        default=None,
        help="GitHub App installation ID; when supplied a PR is created",
    )
    fix.add_argument(
        "--base-branch",
        default="main",
        help="target branch for the pull request",
    )
    fix.add_argument(
        "--repository",
        default="",
        help="owner/name of the GitHub repository (required when --installation-id is set)",
    )

    # Fargate variant: all inputs arrive as env vars injected by the ECS agent /
    # Lambda task-override. The diff is read from NETRA_REMEDIATION_DIFF rather
    # than from a file (no shared filesystem between the Lambda and the task).
    sub.add_parser(
        "remediate-from-env",
        help="apply an approved remediation using environment variables (Fargate mode)",
    )

    args = parser.parse_args(argv)
    config = InvestigatorConfig.from_env()

    if args.command == "doctor":
        from .diagnostics import doctor

        return doctor(config)
    if args.command == "smoke":
        from .diagnostics import smoke

        return smoke(config)

    # ------------------------------------------------------------------
    # remediate-from-env: Fargate path where inputs arrive via env vars.
    # We clone the repository, write the diff to a temp file, then run
    # exactly the same logic as the `remediate` command.
    # ------------------------------------------------------------------
    if args.command == "remediate-from-env":
        return _remediate_from_env(config)

    emit = ndjson_sink()
    emitter = EventEmitter(args.investigation_id, emit)

    if args.command == "run":
        outcome = run_investigation(
            InvestigationRequest(
                investigation_id=args.investigation_id,
                repo_path=args.repo,
                base_sha=args.base_sha,
                head_sha=args.head_sha,
                repository_full_name=args.repository,
                change_title=args.title,
            ),
            emitter,
            config,
        )
        _emit_result(asdict(outcome))
        return 0 if outcome.status != "FAILED" else 1

    applied = apply_remediation(
        args.repo,
        args.diff_file.read_text(),
        investigation_reference=args.reference,
        finding_title=args.finding_title,
        approver=args.approver,
    )
    emitter.status_changed("REMEDIATING")

    # Push the branch and create a PR when a real GitHub installation is available.
    # Skipped gracefully for demo investigations (installation_id is None).
    pr_url: str | None = None
    pr_branch: str | None = None
    pr_commit_sha: str | None = None
    if args.installation_id is not None and args.repository:
        github_secret = os.environ.get("NETRA_GITHUB_APP_SECRET", "")
        if github_secret:
            try:
                credentials = AppCredentials.from_secret(github_secret)
                pr = push_and_create_pr(
                    args.repo,
                    applied,
                    repository_full_name=args.repository,
                    base_branch=args.base_branch,
                    finding_title=args.finding_title,
                    investigation_reference=args.reference,
                    approver=args.approver,
                    installation_id=args.installation_id,
                    app_credentials=credentials,
                )
                pr_url = pr.url
                pr_branch = pr.branch
                pr_commit_sha = pr.commit_sha
            except Exception as exc:  # noqa: BLE001
                # PR creation failure is non-fatal: the remediation was already
                # applied. Log the error and continue to post-fix verification.
                logging.getLogger(__name__).warning(
                    "PR creation failed (remediation was applied): %s", exc
                )
        else:
            logging.getLogger(__name__).warning(
                "--installation-id supplied but NETRA_GITHUB_APP_SECRET is absent; "
                "skipping PR creation"
            )

    result = verify_after_fix(
        args.repo,
        emitter,
        finding_id=args.finding_id,
        base_sha=args.base_sha,
        fixed_sha=applied.commit_sha,
        config=config,
    )
    _emit_result(
        {
            "status": "RESOLVED" if result["status"] == "REFUTED" else "FAILED",
            "branch": applied.branch,
            "commitSha": applied.commit_sha,
            "filesChanged": applied.files_changed,
            "verification": result,
            "prUrl": pr_url,
            "prBranch": pr_branch,
            "prCommitSha": pr_commit_sha,
        }
    )
    return 0


def _emit_result(payload: dict) -> None:
    sys.stdout.write(json.dumps({"type": "result", "result": payload}, default=str) + "\n")
    sys.stdout.flush()


def _remediate_from_env(config: InvestigatorConfig) -> int:
    """Fargate entrypoint for the remediation task.

    All inputs arrive as environment variables injected by the ECS agent and
    the Lambda task-override. No secret values are read here: NETRA_GITHUB_APP_SECRET
    is already in the process environment because the ECS agent resolved it from
    Secrets Manager before the container started.

    The diff is passed via NETRA_REMEDIATION_DIFF (not a file) since there is
    no shared filesystem between the approving Lambda and this Fargate task.

    Note: verify_after_fix (DockerSandbox) is intentionally skipped here because
    Fargate containers cannot run Docker-in-Docker. The deterministic patch
    application + PR creation is the verification boundary for this phase.
    """
    import tempfile

    _log = logging.getLogger(__name__)

    def req(key: str) -> str:
        val = os.environ.get(key, "").strip()
        if not val:
            raise RuntimeError(f"Required env var {key} is not set")
        return val

    investigation_id = req("NETRA_INVESTIGATION_ID")
    reference = os.environ.get("NETRA_REMEDIATION_REFERENCE", "").strip() or investigation_id
    base_sha = req("NETRA_REMEDIATION_BASE_SHA")
    finding_title = req("NETRA_REMEDIATION_FINDING_TITLE")
    approver = req("NETRA_REMEDIATION_APPROVER")
    repository = req("NETRA_REPOSITORY")
    head_sha = req("NETRA_HEAD_SHA")
    base_branch = os.environ.get("NETRA_BASE_BRANCH", "main").strip()
    installation_id_str = os.environ.get("NETRA_INSTALLATION_ID", "").strip()
    installation_id = int(installation_id_str) if installation_id_str.isdigit() else None
    table_name = req("NETRA_TABLE_NAME")   # must exist to read diff + persist result
    region = os.environ.get("AWS_REGION", "eu-north-1")

    # Read the diff from DynamoDB instead of an env var — env vars cannot
    # reliably carry multi-line unified diffs through JSON serialisation without
    # corruption (the ECS override JSON encoding mangles backslashes/newlines).
    import boto3 as _boto3
    _dynamo = _boto3.resource("dynamodb", region_name=region)
    _table = _dynamo.Table(table_name)
    _rem_item = _table.get_item(
        Key={"pk": f"INV#{investigation_id}", "sk": "REMEDIATION"}
    ).get("Item", {})
    diff_content = _rem_item.get("diff", "")
    if not diff_content:
        raise RuntimeError(f"No REMEDIATION.diff found in DynamoDB for {investigation_id}")
    _log.info("diff loaded from DynamoDB: %d bytes", len(diff_content))


    # Clone the repository so we have a working tree to apply the patch to.
    from .aws.github import AppCredentials, clone_repository, mint_app_jwt, installation_token

    repo_dir = tempfile.mkdtemp(prefix="netra-remediate-")
    repo_path = Path(repo_dir)

    try:
        github_secret = os.environ.get("NETRA_GITHUB_APP_SECRET", "")
        if not github_secret:
            raise RuntimeError("NETRA_GITHUB_APP_SECRET is not set — cannot clone repository")

        credentials = AppCredentials.from_secret(github_secret)
        token = installation_token(mint_app_jwt(credentials), installation_id or 0) if installation_id else None

        if token:
            _log.info("cloning %s at %s", repository, head_sha[:12])
            clone_repository(
                repository,
                token,
                repo_path / "repo",
                commits=(head_sha, base_sha),
            )
        else:
            import subprocess as _sp
            _sp.run(
                ["git", "clone", "--quiet", f"https://github.com/{repository}.git",
                 str(repo_path / "repo")],
                check=True, timeout=120,
            )

        actual_repo = repo_path / "repo"

        # The clone lands on the default branch (main). The diff was generated
        # against head_sha, so we must check that out before applying the patch.
        import subprocess as _sp
        _log.info("checking out head_sha %s", head_sha[:12])
        _sp.run(
            ["git", "-C", str(actual_repo), "checkout", "--quiet", head_sha],
            check=True, timeout=30,
        )

        _log.info("applying remediation patch")
        # Configure git identity — Fargate has no global git config.
        for _kv in [
            ("user.email", "netra-bot@netra.internal"),
            ("user.name", "Netra Remediation Bot"),
        ]:
            _sp.run(
                ["git", "-C", str(actual_repo), "config", _kv[0], _kv[1]],
                check=True, timeout=10,
            )
        applied = apply_remediation(
            actual_repo,
            diff_content,
            investigation_reference=reference,
            finding_title=finding_title,
            approver=approver,
        )
        _log.info("patch applied: branch=%s commit=%s", applied.branch, applied.commit_sha[:12])

        # Push branch + create GitHub PR
        pr_url: str | None = None
        pr_branch: str | None = None
        pr_commit_sha: str | None = None
        if installation_id is not None:
            try:
                pr = push_and_create_pr(
                    actual_repo,
                    applied,
                    repository_full_name=repository,
                    base_branch=base_branch,
                    finding_title=finding_title,
                    investigation_reference=reference,
                    approver=approver,
                    installation_id=installation_id,
                    app_credentials=credentials,
                )
                pr_url = pr.url
                pr_branch = pr.branch
                pr_commit_sha = pr.commit_sha
                _log.info("pull request created: %s", pr_url)
            except Exception as exc:  # noqa: BLE001
                _log.warning("PR creation failed (remediation applied locally): %s", exc)

        # Persist result to DynamoDB (same pattern as aws/task.py).
        # We skip DockerSandbox-based verify_after_fix here because Fargate
        # containers cannot run Docker-in-Docker. The patch application itself
        # IS the deterministic verification.
        if table_name:
            from .aws.store import InvestigationStore
            import boto3
            store = InvestigationStore(table_name, region=region)

            # Update META → RESOLVED (with PR URL in extra)
            meta_extra: dict = {}
            if pr_url:
                meta_extra["prUrl"] = pr_url
                meta_extra["prBranch"] = pr_branch
                meta_extra["prCommitSha"] = pr_commit_sha
            store.set_status(investigation_id, "RESOLVED", extra=meta_extra)
            _log.info("investigation %s set to RESOLVED", investigation_id)

            # Also write the PR URL to the ACTION record's resultUrl field so
            # the approval endpoint / UI can surface it directly.
            if pr_url:
                dynamo = boto3.resource("dynamodb", region_name=region)
                table = dynamo.Table(table_name)
                table.update_item(
                    Key={"pk": f"INV#{investigation_id}", "sk": "ACTION"},
                    UpdateExpression="SET resultUrl = :url, prBranch = :branch, prCommitSha = :sha",
                    ExpressionAttributeValues={
                        ":url": pr_url,
                        ":branch": pr_branch or "",
                        ":sha": pr_commit_sha or "",
                    },
                )
                _log.info("ACTION resultUrl set to %s", pr_url)

        _emit_result({
            "status": "RESOLVED",
            "branch": applied.branch,
            "commitSha": applied.commit_sha,
            "filesChanged": applied.files_changed,
            "prUrl": pr_url,
            "prBranch": pr_branch,
            "prCommitSha": pr_commit_sha,
        })
        return 0

    except Exception as exc:  # noqa: BLE001
        _log.error("remediate-from-env failed: %s", exc)
        _emit_result({"status": "FAILED", "error": str(exc)})
        return 1
    finally:
        import shutil
        shutil.rmtree(repo_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

