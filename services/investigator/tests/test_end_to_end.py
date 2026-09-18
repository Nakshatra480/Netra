"""The complete investigation loop, exercised against a real repository.

change -> investigation -> evidence -> verification -> blast radius
       -> human approval -> remediation -> post-fix verification -> resolved

No model gateway is required: the model contributes narrative, the
deterministic analyzer contributes the verdict, and this test asserts the
verdict.
"""

from pathlib import Path

import pytest
from support import requires_docker

from netra_investigator.config import InvestigatorConfig
from netra_investigator.events import EventEmitter, collecting_sink
from netra_investigator.pipeline import InvestigationRequest, run_investigation
from netra_investigator.remediate import apply_remediation, verify_after_fix

pytestmark = requires_docker


@pytest.fixture
def config() -> InvestigatorConfig:
    return InvestigatorConfig.from_env()


@pytest.fixture
def investigation(demo_repo: Path, demo_shas: tuple[str, str], config, monkeypatch):
    """Run the pipeline without the model, so the test asserts proven facts."""
    from netra_investigator import pipeline

    monkeypatch.setattr(
        pipeline,
        "investigate",
        lambda *_args, **_kwargs: pipeline.AgentHypothesis.unavailable("disabled in test"),
    )
    base, head = demo_shas
    events: list[dict] = []
    emitter = EventEmitter("inv_e2e", collecting_sink(events))
    outcome = run_investigation(
        InvestigationRequest(
            investigation_id="inv_e2e",
            repo_path=demo_repo,
            base_sha=base,
            head_sha=head,
            repository_full_name="orbital/payments",
            change_title="Enable direct receipt upload from the browser",
        ),
        emitter,
        config,
    )
    return outcome, events


class TestInvestigation:
    def test_stops_for_human_approval(self, investigation) -> None:
        outcome, _ = investigation
        # The pipeline must never remediate on its own.
        assert outcome.status == "AWAITING_APPROVAL"
        assert outcome.action is not None
        assert outcome.action["status"] == "PENDING"
        assert outcome.action["approvedBy"] is None

    def test_produces_a_verified_critical_finding(self, investigation) -> None:
        outcome, _ = investigation
        assert outcome.finding is not None
        assert outcome.finding["category"] == "CREDENTIAL_EXPOSURE"
        assert outcome.finding["severity"] == "CRITICAL"
        assert outcome.finding["verificationStatus"] == "VERIFIED"
        assert "AWS_SECRET_ACCESS_KEY" in outcome.finding["subject"]

    def test_every_finding_is_backed_by_evidence(self, investigation) -> None:
        outcome, _ = investigation
        assert outcome.evidence
        for item in outcome.evidence:
            assert item["findingId"] == outcome.finding["id"]
            assert item["file"]
            assert item["producedBy"] == "secret-flow-v1"

    def test_verification_is_deterministic_and_recorded(self, investigation) -> None:
        outcome, _ = investigation
        assert len(outcome.verifications) == 1
        verification = outcome.verifications[0]
        assert verification["status"] == "VERIFIED"
        assert verification["phase"] == "PRE_FIX"
        assert verification["verifier"] == "secret-flow-v1"

    def test_blast_radius_connects_the_change_to_the_finding(self, investigation) -> None:
        outcome, _ = investigation
        graph = outcome.graph
        assert graph is not None
        kinds = {n["kind"] for n in graph["nodes"]}
        assert {"CHANGED_FILE", "SECRET", "FINDING"} <= kinds
        assert any(n["onAffectedPath"] for n in graph["nodes"])
        assert graph["summary"]

    def test_walks_the_lifecycle_in_order(self, investigation) -> None:
        _, events = investigation
        statuses = [e["status"] for e in events if e["type"] == "status_changed"]
        assert statuses == [
            "CREATED",
            "PREPARING",
            "INVESTIGATING",
            "EVIDENCE_COLLECTION",
            "VERIFYING",
            "IMPACT_ANALYSIS",
            "RECOMMENDATION",
            "AWAITING_APPROVAL",
        ]

    def test_terminal_shows_real_commands(self, investigation) -> None:
        _, events = investigation
        starts = [e for e in events if e["type"] == "command_started"]
        finishes = [e for e in events if e["type"] == "command_finished"]
        assert len(starts) == len(finishes) >= 5
        assert all(e["command"].split()[0] in {"git", "rg", "cat"} for e in starts)
        assert any(e["type"] == "command_output" for e in events)

    def test_events_are_sequenced_without_gaps(self, investigation) -> None:
        _, events = investigation
        assert [e["seq"] for e in events] == list(range(1, len(events) + 1))

    def test_no_model_reasoning_is_emitted(self, investigation) -> None:
        _, events = investigation
        # Activity events are summaries the pipeline chose; nothing carries
        # a field that could hold chain-of-thought.
        for event in events:
            assert "reasoning" not in event
            assert "thinking" not in event


class TestApprovalAndRemediation:
    def test_remediation_is_proposed_but_not_applied(self, investigation) -> None:
        outcome, _ = investigation
        assert outcome.remediation is not None
        assert outcome.remediation["diff"].startswith("diff --git")
        assert "src/client/config.js" in outcome.remediation["affectedFiles"]

    def test_approved_remediation_resolves_the_investigation(
        self, investigation, demo_repo: Path, demo_shas: tuple[str, str], config
    ) -> None:
        outcome, _ = investigation
        base, _head = demo_shas

        applied = apply_remediation(
            demo_repo,
            outcome.remediation["diff"],
            investigation_reference="INV-E2E",
            finding_title=outcome.finding["title"],
            approver="reviewer@example.com",
        )
        assert applied.commit_sha
        assert applied.branch.startswith("netra/remediation/")

        events: list[dict] = []
        emitter = EventEmitter("inv_e2e", collecting_sink(events))
        result = verify_after_fix(
            demo_repo,
            emitter,
            finding_id=outcome.finding["id"],
            base_sha=base,
            fixed_sha=applied.commit_sha,
            config=config,
        )

        # The same check that proved the exposure must now fail to find it.
        assert result["status"] == "REFUTED"
        assert result["phase"] == "POST_FIX"
        statuses = [e["status"] for e in events if e["type"] == "status_changed"]
        assert statuses == ["POST_FIX_VERIFY", "RESOLVED"]
