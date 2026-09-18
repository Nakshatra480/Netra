"""The deterministic analyzer must prove exposure, and must stay quiet otherwise."""

from pathlib import Path

import pytest
from support import requires_docker

from netra_investigator.analyzers.secret_flow import SecretFlowAnalyzer, is_secret_name
from netra_investigator.events import EventEmitter, collecting_sink
from netra_investigator.sandbox import DockerSandbox
from netra_investigator.tools import InvestigationTools


class TestSecretNaming:
    @pytest.mark.parametrize(
        "name",
        [
            "AWS_SECRET_ACCESS_KEY",
            "AWS_ACCESS_KEY_ID",
            "STRIPE_API_KEY",
            "DATABASE_PASSWORD",
            "JWT_SIGNING_KEY",
            "GITHUB_CLIENT_SECRET",
            "SESSION_SECRET",
        ],
    )
    def test_recognises_credentials(self, name: str) -> None:
        assert is_secret_name(name)

    @pytest.mark.parametrize(
        "name",
        ["AWS_REGION", "VITE_API_BASE_URL", "NODE_ENV", "LEDGER_TABLE", "PUBLIC_API_KEY"],
    )
    def test_does_not_flag_safe_configuration(self, name: str) -> None:
        # Over-reporting is the failure mode that makes a security tool ignored.
        assert not is_secret_name(name)


@requires_docker
class TestAnalysisOfTheRiskyChange:
    @pytest.fixture(scope="class")
    def report(self, demo_repo: Path, demo_shas: tuple[str, str]):
        base, head = demo_shas
        events: list[dict] = []
        emitter = EventEmitter("inv_test", collecting_sink(events))
        with DockerSandbox(demo_repo, checkout=head) as sandbox:
            tools = InvestigationTools(sandbox, emitter, base, head)
            report = SecretFlowAnalyzer(tools).analyze()
        return report, events, tools.calls

    def test_identifies_the_secret_introduced_by_the_change(self, report) -> None:
        result, _, _ = report
        introduced = {r.secret for r in result.secrets_introduced}
        assert "AWS_SECRET_ACCESS_KEY" in introduced
        assert "AWS_ACCESS_KEY_ID" in introduced

    def test_derives_the_client_surface_from_the_build_config(self, report) -> None:
        result, _, _ = report
        assert result.surface is not None
        assert result.surface.root == "src/client"
        assert result.surface.config_file == "vite.config.js"
        assert "src/client/main.js" in result.surface.entries

    def test_detects_the_bundler_inlining_the_secret(self, report) -> None:
        result, _, _ = report
        assert "AWS_SECRET_ACCESS_KEY" in result.inlined_by_bundler

    def test_traces_a_path_from_the_browser_entry_to_the_secret(self, report) -> None:
        result, _, _ = report
        paths = [p for p in result.exposure_paths if p.secret == "AWS_SECRET_ACCESS_KEY"]
        assert paths, "expected a traced exposure path"
        # The path must start at a browser entry point and end at the reading file.
        for path in paths:
            assert path.hops[0] in result.surface.entries
            assert path.hops[-1] == path.reference.file

    def test_concludes_the_secret_is_exposed(self, report) -> None:
        result, _, _ = report
        assert result.exposed
        assert "AWS_SECRET_ACCESS_KEY" in result.exposed_secrets

    def test_every_conclusion_came_from_a_real_command(self, report) -> None:
        _, events, calls = report
        assert calls, "analysis must run commands, not infer from nothing"
        started = [e for e in events if e["type"] == "command_started"]
        finished = [e for e in events if e["type"] == "command_finished"]
        assert len(started) == len(finished) == len(calls)
        # Terminal output is real command output, not narration.
        assert any(e["type"] == "command_output" for e in events)


@requires_docker
class TestAnalysisOfTheSafeBaseline:
    def test_reports_no_exposure_before_the_risky_change(
        self, demo_repo: Path, demo_shas: tuple[str, str]
    ) -> None:
        base, _ = demo_shas
        emitter = EventEmitter("inv_test", collecting_sink([]))
        # The workspace is pinned to the baseline commit, so this is the state of
        # the repository before the risky change was made.
        with DockerSandbox(demo_repo, checkout=base) as sandbox:
            tools = InvestigationTools(sandbox, emitter, base, base)
            result = SecretFlowAnalyzer(tools).analyze()
        assert result.secrets_introduced == []
        assert result.exposure_paths == []
        assert result.inlined_by_bundler == []
        assert not result.exposed
