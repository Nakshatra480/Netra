"""Tests for the remediation PR creation path.

All GitHub I/O is stubbed with unittest.mock so no real network calls are made.
"""
from __future__ import annotations

import json as _json
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from netra_investigator.aws.github import AppCredentials, GitHubUnavailable
from netra_investigator.remediate import (
    AppliedRemediation,
    PullRequest,
    RemediationFailed,
    push_and_create_pr,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

FAKE_CREDENTIALS = AppCredentials(app_id="123", private_key="---FAKE---")
FAKE_TOKEN = "ghs_fake_installation_token"
FAKE_PR_URL = "https://github.com/Nakshatra480/Netra/pull/42"


@pytest.fixture()
def applied() -> AppliedRemediation:
    return AppliedRemediation(
        branch="netra/remediation/inv-001",
        commit_sha="abc123",
        files_changed=["fixture/src/client/config.js"],
    )


# ---------------------------------------------------------------------------
# push_and_create_pr — success path
# ---------------------------------------------------------------------------


def test_push_and_create_pr_success(tmp_path: Path, applied: AppliedRemediation) -> None:
    """Happy path: token minted, branch pushed, PR created, PullRequest returned."""
    with (
        patch("netra_investigator.remediate.mint_app_jwt", return_value="app.jwt.token"),
        patch("netra_investigator.remediate.installation_token", return_value=FAKE_TOKEN),
        patch("netra_investigator.remediate.push_branch") as mock_push,
        patch("netra_investigator.remediate.create_pull_request", return_value=FAKE_PR_URL) as mock_pr,
    ):
        result = push_and_create_pr(
            tmp_path,
            applied,
            repository_full_name="Nakshatra480/Netra",
            base_branch="main",
            finding_title="2 credentials reach the browser bundle",
            investigation_reference="INV-001",
            approver="alice@example.com",
            installation_id=162823444,
            app_credentials=FAKE_CREDENTIALS,
        )

    assert isinstance(result, PullRequest)
    assert result.url == FAKE_PR_URL
    assert result.branch == applied.branch
    assert result.commit_sha == applied.commit_sha
    mock_push.assert_called_once()
    mock_pr.assert_called_once()


def test_pr_title_contains_finding_title(tmp_path: Path, applied: AppliedRemediation) -> None:
    with (
        patch("netra_investigator.remediate.mint_app_jwt", return_value="jwt"),
        patch("netra_investigator.remediate.installation_token", return_value=FAKE_TOKEN),
        patch("netra_investigator.remediate.push_branch"),
        patch("netra_investigator.remediate.create_pull_request", return_value=FAKE_PR_URL) as mock_pr,
    ):
        push_and_create_pr(
            tmp_path, applied,
            repository_full_name="Nakshatra480/Netra",
            base_branch="main",
            finding_title="2 credentials reach the browser bundle",
            investigation_reference="INV-001",
            approver="alice",
            installation_id=162823444,
            app_credentials=FAKE_CREDENTIALS,
        )
    _, kwargs = mock_pr.call_args
    assert "2 credentials reach the browser bundle" in kwargs["title"]


def test_pr_body_contains_approver(tmp_path: Path, applied: AppliedRemediation) -> None:
    with (
        patch("netra_investigator.remediate.mint_app_jwt", return_value="jwt"),
        patch("netra_investigator.remediate.installation_token", return_value=FAKE_TOKEN),
        patch("netra_investigator.remediate.push_branch"),
        patch("netra_investigator.remediate.create_pull_request", return_value=FAKE_PR_URL) as mock_pr,
    ):
        push_and_create_pr(
            tmp_path, applied,
            repository_full_name="Nakshatra480/Netra",
            base_branch="main",
            finding_title="Cred exposure",
            investigation_reference="INV-001",
            approver="priya@orbital.example",
            installation_id=162823444,
            app_credentials=FAKE_CREDENTIALS,
        )
    _, kwargs = mock_pr.call_args
    assert "priya@orbital.example" in kwargs["body"]


def test_pr_body_contains_investigation_reference(
    tmp_path: Path, applied: AppliedRemediation
) -> None:
    with (
        patch("netra_investigator.remediate.mint_app_jwt", return_value="jwt"),
        patch("netra_investigator.remediate.installation_token", return_value=FAKE_TOKEN),
        patch("netra_investigator.remediate.push_branch"),
        patch("netra_investigator.remediate.create_pull_request", return_value=FAKE_PR_URL) as mock_pr,
    ):
        push_and_create_pr(
            tmp_path, applied,
            repository_full_name="Nakshatra480/Netra",
            base_branch="main",
            finding_title="Cred",
            investigation_reference="INV-XYZ",
            approver="alice",
            installation_id=162823444,
            app_credentials=FAKE_CREDENTIALS,
        )
    _, kwargs = mock_pr.call_args
    assert "INV-XYZ" in kwargs["body"]


def test_push_uses_correct_head_base(tmp_path: Path, applied: AppliedRemediation) -> None:
    with (
        patch("netra_investigator.remediate.mint_app_jwt", return_value="jwt"),
        patch("netra_investigator.remediate.installation_token", return_value=FAKE_TOKEN),
        patch("netra_investigator.remediate.push_branch") as mock_push,
        patch("netra_investigator.remediate.create_pull_request", return_value=FAKE_PR_URL) as mock_pr,
    ):
        push_and_create_pr(
            tmp_path, applied,
            repository_full_name="Nakshatra480/Netra",
            base_branch="fixture/credential-exposure",
            finding_title="Cred",
            investigation_reference="INV-001",
            approver="alice",
            installation_id=162823444,
            app_credentials=FAKE_CREDENTIALS,
        )
    _, pr_kwargs = mock_pr.call_args
    assert pr_kwargs["head"] == applied.branch
    assert pr_kwargs["base"] == "fixture/credential-exposure"


# ---------------------------------------------------------------------------
# push_and_create_pr — failure paths
# ---------------------------------------------------------------------------


def test_push_failure_raises_remediation_failed(
    tmp_path: Path, applied: AppliedRemediation
) -> None:
    with (
        patch("netra_investigator.remediate.mint_app_jwt", return_value="jwt"),
        patch("netra_investigator.remediate.installation_token", return_value=FAKE_TOKEN),
        patch(
            "netra_investigator.remediate.push_branch",
            side_effect=GitHubUnavailable("network error"),
        ),
    ):
        with pytest.raises(RemediationFailed, match="could not push remediation branch"):
            push_and_create_pr(
                tmp_path, applied,
                repository_full_name="Nakshatra480/Netra",
                base_branch="main",
                finding_title="Cred",
                investigation_reference="INV-001",
                approver="alice",
                installation_id=162823444,
                app_credentials=FAKE_CREDENTIALS,
            )


def test_github_api_refusal_raises_remediation_failed(
    tmp_path: Path, applied: AppliedRemediation
) -> None:
    with (
        patch("netra_investigator.remediate.mint_app_jwt", return_value="jwt"),
        patch("netra_investigator.remediate.installation_token", return_value=FAKE_TOKEN),
        patch("netra_investigator.remediate.push_branch"),
        patch(
            "netra_investigator.remediate.create_pull_request",
            side_effect=GitHubUnavailable("GitHub refused PR creation (HTTP 422)"),
        ),
    ):
        with pytest.raises(RemediationFailed, match="could not create pull request"):
            push_and_create_pr(
                tmp_path, applied,
                repository_full_name="Nakshatra480/Netra",
                base_branch="main",
                finding_title="Cred",
                investigation_reference="INV-001",
                approver="alice",
                installation_id=162823444,
                app_credentials=FAKE_CREDENTIALS,
            )


def test_token_minting_failure_raises_remediation_failed(
    tmp_path: Path, applied: AppliedRemediation
) -> None:
    with patch(
        "netra_investigator.remediate.mint_app_jwt",
        side_effect=GitHubUnavailable("could not sign"),
    ):
        with pytest.raises(RemediationFailed, match="could not obtain a GitHub token"):
            push_and_create_pr(
                tmp_path, applied,
                repository_full_name="Nakshatra480/Netra",
                base_branch="main",
                finding_title="Cred",
                investigation_reference="INV-001",
                approver="alice",
                installation_id=162823444,
                app_credentials=FAKE_CREDENTIALS,
            )


# ---------------------------------------------------------------------------
# PR skipped when no installation_id (demo mode)
# ---------------------------------------------------------------------------


def test_no_installation_id_gate_condition_is_false() -> None:
    """The gate in __main__.py is `args.installation_id is not None and args.repository`.
    When installation_id is None the condition must be falsy — no push, no PR."""
    installation_id = None
    repository = "Nakshatra480/Netra"
    should_create_pr = installation_id is not None and bool(repository)
    assert not should_create_pr


def test_no_repository_gate_condition_is_false() -> None:
    installation_id = 162823444
    repository = ""
    should_create_pr = installation_id is not None and bool(repository)
    assert not should_create_pr


# ---------------------------------------------------------------------------
# create_pull_request — payload correctness (no real network)
# ---------------------------------------------------------------------------


def test_create_pull_request_sends_correct_payload() -> None:
    """Verify the correct JSON body and auth header are sent to the GitHub API."""
    from netra_investigator.aws.github import create_pull_request

    fake_response_data = {"html_url": FAKE_PR_URL, "number": 42}
    captured: list = []

    class FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            pass

    def fake_urlopen(req, timeout=None):
        captured.append(req)
        return FakeResponse()

    with (
        patch.object(urllib.request, "urlopen", fake_urlopen),
        patch("netra_investigator.aws.github.json.load", return_value=fake_response_data),
    ):
        url = create_pull_request(
            "ghs_tok",
            "owner/repo",
            head="netra/remediation/inv-001",
            base="main",
            title="Fix: creds",
            body="PR body text",
        )

    assert url == FAKE_PR_URL
    req = captured[0]
    body = _json.loads(req.data)
    assert body["head"] == "netra/remediation/inv-001"
    assert body["base"] == "main"
    assert body["title"] == "Fix: creds"
    auth = req.get_header("Authorization")
    assert "Bearer ghs_tok" in auth
