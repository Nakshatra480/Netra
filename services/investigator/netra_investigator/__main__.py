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
import sys
from dataclasses import asdict
from pathlib import Path

from .config import InvestigatorConfig
from .events import EventEmitter, ndjson_sink
from .pipeline import InvestigationRequest, run_investigation
from .remediate import apply_remediation, verify_after_fix


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

    args = parser.parse_args(argv)
    config = InvestigatorConfig.from_env()
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
        }
    )
    return 0


def _emit_result(payload: dict) -> None:
    sys.stdout.write(json.dumps({"type": "result", "result": payload}, default=str) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
