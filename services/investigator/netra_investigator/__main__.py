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

from .aws.github import AppCredentials
from .config import InvestigatorConfig
from .events import EventEmitter, ndjson_sink
from .pipeline import InvestigationRequest, run_investigation
from .remediate import apply_remediation, push_and_create_pr, verify_after_fix


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


def _remediate_from_env(config: InvestigatorConfig) -> int:  # noqa: ARG001
    """Fargate entrypoint for the remediation task.

    All inputs arrive as environment variables injected by the ECS agent and
    the Lambda task-override. No secret values are read here: NETRA_GITHUB_APP_SECRET
    is already in the process environment because the ECS agent resolved it from
    Secrets Manager before the container started.

    The diff is passed via NETRA_REMEDIATION_DIFF (not a file) since there is
    no shared filesystem between the approving Lambda and this Fargate task.

    After the patch is applied and the PR is opened, the same deterministic
    analyzer is re-run against the new commit inside a TaskSandbox (Fargate
    cannot nest containers). Only a REFUTED post-fix verification resolves the
    investigation.
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
    # The finding this remediation answers — needed to attach the POST_FIX
    # verification record to the same finding as the PRE_FIX one.
    finding_id = str(_rem_item.get("findingId", "") or "").strip()
    if not diff_content:
        raise RuntimeError(f"No REMEDIATION.diff found in DynamoDB for {investigation_id}")
    if not finding_id:
        # Without it the post-fix verification cannot be attached to a finding,
        # and an unattached verification cannot justify RESOLVED.
        raise RuntimeError(f"No REMEDIATION.findingId found in DynamoDB for {investigation_id}")
    _log.info("diff loaded from DynamoDB: %d bytes", len(diff_content))


    # Clone the repository so we have a working tree to apply the patch to.
    from .aws.github import AppCredentials, clone_repository, installation_token, mint_app_jwt

    repo_dir = tempfile.mkdtemp(prefix="netra-remediate-")
    repo_path = Path(repo_dir)

    try:
        github_secret = os.environ.get("NETRA_GITHUB_APP_SECRET", "")
        if not github_secret:
            raise RuntimeError("NETRA_GITHUB_APP_SECRET is not set — cannot clone repository")

        credentials = AppCredentials.from_secret(github_secret)
        token = (
            installation_token(mint_app_jwt(credentials), installation_id)
            if installation_id
            else None
        )

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

        # ── Post-fix verification ────────────────────────────────────────
        #
        # A patch applying cleanly proves the diff was well-formed. It proves
        # nothing about security. RESOLVED is only justified once the same
        # deterministic analyzer has been re-run against the new commit and can
        # no longer find the exposure.
        #
        # Fargate cannot nest containers, so the boundary is the task itself.
        from .events import EventEmitter, collecting_sink
        from .sandbox.executor import TaskSandbox

        post_fix_sha = applied.commit_sha
        verification: dict | None = None
        verify_error: str | None = None

        verify_events: list[dict] = []
        emitter = EventEmitter(investigation_id, collecting_sink(verify_events))

        try:
            _log.info("running post-fix verification against %s", post_fix_sha[:12])
            verification = verify_after_fix(
                actual_repo,
                emitter,
                finding_id=finding_id,
                base_sha=head_sha,
                fixed_sha=post_fix_sha,
                sandbox_factory=lambda path, _image, limits, checkout: TaskSandbox(
                    path, limits=limits, checkout=checkout
                ),
            )
            _log.info("post-fix verification: %s", verification["status"])
        except Exception as exc:  # noqa: BLE001
            # An error is not a pass. The investigation does not resolve.
            verify_error = str(exc)[:500]
            _log.error("post-fix verification errored: %s", verify_error)

        # REFUTED means the analyzer can no longer find the finding. Anything
        # else — still VERIFIED, inconclusive, or an error — is not a pass.
        verified_clean = bool(verification) and verification["status"] == "REFUTED"

        if verified_clean:
            final_status = "RESOLVED"
            failure_reason = None
        elif verify_error:
            final_status = "FAILED"
            failure_reason = f"Post-fix verification could not run: {verify_error}"
        else:
            final_status = "FAILED"
            failure_reason = (
                "Post-fix verification still finds the issue after the fix "
                f"({(verification or {}).get('status', 'no result')})."
            )

        if table_name:
            import boto3

            from .aws.store import InvestigationStore
            store = InvestigationStore(table_name, region=region)

            # Persist the verification before the status, so a reader can never
            # see RESOLVED without the record that justifies it.
            if verification:
                store.put_verifications(investigation_id, [verification])
                _log.info("POST_FIX verification persisted")

            meta_extra: dict = {
                "preFixSha": head_sha,
                "postFixSha": post_fix_sha,
                "postFixCheckId": (verification or {}).get("checkId"),
                "postFixStatus": (verification or {}).get("status") or "ERROR",
            }
            if pr_url:
                meta_extra["prUrl"] = pr_url
                meta_extra["prBranch"] = pr_branch
                meta_extra["prCommitSha"] = pr_commit_sha

            store.set_status(
                investigation_id,
                final_status,
                failure_reason=failure_reason,
                extra=meta_extra,
            )
            _log.info("investigation %s set to %s", investigation_id, final_status)

            if verify_events:
                store.put_events(investigation_id, verify_events)

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
            "status": final_status,
            "branch": applied.branch,
            "commitSha": applied.commit_sha,
            "filesChanged": applied.files_changed,
            "prUrl": pr_url,
            "prBranch": pr_branch,
            "prCommitSha": pr_commit_sha,
            "preFixSha": head_sha,
            "postFixSha": post_fix_sha,
            "postFixStatus": (verification or {}).get("status") or "ERROR",
            "verifyError": verify_error,
        })
        return 0 if verified_clean else 1

    except Exception as exc:  # noqa: BLE001
        _log.error("remediate-from-env failed: %s", exc)
        _emit_result({"status": "FAILED", "error": str(exc)})
        return 1
    finally:
        import shutil
        shutil.rmtree(repo_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

