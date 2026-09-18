"""The task-level sandbox used where Docker-in-Docker is impossible.

Fargate cannot nest containers, so the task itself is the isolation boundary.
These tests pin the properties that boundary still has to provide: a private
workspace, a stripped environment, bounded output and time, and the same
allowlist governing every command.
"""

from pathlib import Path

import pytest
from support import requires_ripgrep

from netra_investigator.analyzers.secret_flow import SecretFlowAnalyzer
from netra_investigator.events import EventEmitter, collecting_sink
from netra_investigator.sandbox import CommandDenied, SandboxError, SandboxLimits
from netra_investigator.sandbox.allowlist import SandboxCommand, git_diff, search_literal
from netra_investigator.sandbox.executor import TaskSandbox
from netra_investigator.tools import InvestigationTools


@pytest.fixture
def sandbox(demo_repo: Path, demo_shas: tuple[str, str]):
    _, head = demo_shas
    with TaskSandbox(demo_repo, checkout=head, limits=SandboxLimits(command_timeout_s=30)) as sb:
        yield sb


class TestWorkspaceIsolation:
    def test_analysis_runs_on_a_private_copy(self, sandbox: TaskSandbox, demo_repo: Path) -> None:
        assert sandbox.workspace != demo_repo
        assert sandbox.workspace.exists()
        # Writing into the copy must not touch the caller's repository.
        (sandbox.workspace / "scratch.txt").write_text("x")
        assert not (demo_repo / "scratch.txt").exists()

    def test_the_workspace_is_destroyed_on_exit(self, demo_repo: Path) -> None:
        with TaskSandbox(demo_repo) as sb:
            workspace = sb.workspace
            assert workspace.exists()
        assert not workspace.exists(), "an ephemeral workspace must not outlive the investigation"

    def test_the_workspace_is_pinned_to_the_commit(
        self, demo_repo: Path, demo_shas: tuple[str, str]
    ) -> None:
        base, _ = demo_shas
        with TaskSandbox(demo_repo, checkout=base) as sb:
            # The risky change added this file in the second commit.
            assert not (sb.workspace / "src/client/receiptUpload.js").exists()

    def test_refuses_a_directory_that_is_not_a_repository(self, tmp_path: Path) -> None:
        with pytest.raises(SandboxError):
            TaskSandbox(tmp_path).start()

    def test_refuses_an_unknown_commit(self, demo_repo: Path) -> None:
        with pytest.raises(SandboxError, match="could not check out"):
            TaskSandbox(demo_repo, checkout="0" * 40).start()


class TestCommandExecution:
    def test_runs_allowlisted_commands_against_the_workspace(
        self, sandbox: TaskSandbox, demo_shas: tuple[str, str]
    ) -> None:
        base, head = demo_shas
        result = sandbox.run(git_diff(base, head, "src/client/config.js"))
        assert result.ok, result.stderr
        assert "AWS_SECRET_ACCESS_KEY" in result.stdout

    @requires_ripgrep
    def test_streams_output_as_it_is_produced(self, sandbox: TaskSandbox) -> None:
        chunks: list[str] = []
        result = sandbox.stream(
            search_literal("AWS_SECRET_ACCESS_KEY"), lambda c: chunks.append(c.text)
        )
        assert result.ok
        assert chunks
        assert "".join(chunks) == result.stdout

    @requires_ripgrep
    def test_reports_a_real_exit_code(self, sandbox: TaskSandbox) -> None:
        # ripgrep exits 1 when nothing matches; that is an answer, not an error.
        assert sandbox.run(search_literal("a-string-that-does-not-occur")).exit_code == 1

    def test_refuses_a_command_outside_the_allowlist(self, sandbox: TaskSandbox) -> None:
        # The boundary changed; the control that matters did not.
        with pytest.raises(CommandDenied):
            sandbox.run(SandboxCommand(argv=("sh", "-c", "cat /etc/passwd"), tool="evil"))
        with pytest.raises(CommandDenied):
            sandbox.run(SandboxCommand(argv=("curl", "http://evil.example"), tool="evil"))

    def test_refuses_to_run_before_it_is_started(self, demo_repo: Path) -> None:
        with pytest.raises(SandboxError):
            TaskSandbox(demo_repo).run(search_literal("anything"))


class TestEnvironmentStripping:
    def test_netra_credentials_are_not_visible_to_analysis(
        self, sandbox: TaskSandbox, monkeypatch
    ) -> None:
        # An analysis subprocess has no business reading Netra's own secrets.
        monkeypatch.setenv("OPENROUTER_API_KEYS", "sk-or-v1-should-not-be-visible")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws-should-not-be-visible")
        monkeypatch.setenv("GITHUB_TOKEN", "ghs_should_not_be_visible")

        env = sandbox._child_env()  # noqa: SLF001 - asserting an internal guarantee
        assert "OPENROUTER_API_KEYS" not in env
        assert "AWS_SECRET_ACCESS_KEY" not in env
        assert "GITHUB_TOKEN" not in env
        assert env["GIT_TERMINAL_PROMPT"] == "0"


class TestAnalyzerParity:
    """The analyzer must reach the same verdict whichever boundary it runs in."""

    @requires_ripgrep
    def test_traces_the_same_exposure_as_the_docker_sandbox(
        self, demo_repo: Path, demo_shas: tuple[str, str]
    ) -> None:
        base, head = demo_shas
        emitter = EventEmitter("inv_task", collecting_sink([]))
        with TaskSandbox(demo_repo, checkout=head) as sb:
            tools = InvestigationTools(sb, emitter, base, head)
            report = SecretFlowAnalyzer(tools).analyze()

        assert report.exposed
        assert "AWS_SECRET_ACCESS_KEY" in report.exposed_secrets
        assert report.exposure_paths
        assert "AWS_SECRET_ACCESS_KEY" in report.inlined_by_bundler
