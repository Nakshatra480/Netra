"""The sandbox must be provably isolated, not isolated by assertion.

These tests execute real containers and check the properties the security model
depends on: no root, no network, no write access, bounded output and time.
"""

import subprocess
from pathlib import Path

import pytest

from netra_investigator.sandbox import DockerSandbox, SandboxLimits
from netra_investigator.sandbox.allowlist import (
    SandboxCommand,
    git_changed_files,
    git_diff,
    search_literal,
)

from support import requires_docker

pytestmark = requires_docker


@pytest.fixture
def sandbox(demo_repo: Path):
    with DockerSandbox(demo_repo, limits=SandboxLimits(command_timeout_s=20)) as sb:
        yield sb


def _raw(sandbox: DockerSandbox, *argv: str) -> subprocess.CompletedProcess[str]:
    """Run a command in the container, bypassing the allowlist.

    Used only to probe the container's own configuration; production code has no
    equivalent path.
    """
    return subprocess.run(
        ["docker", "exec", sandbox._container_id, *argv],  # noqa: SLF001
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


class TestIsolation:
    def test_runs_as_a_non_root_user(self, sandbox: DockerSandbox) -> None:
        result = _raw(sandbox, "id", "-u")
        assert result.stdout.strip() == "10001"

    def test_has_no_network_access(self, sandbox: DockerSandbox) -> None:
        # With --network none the kernel still exposes down tunnel stubs, so the
        # property worth asserting is reachability: no address other than
        # loopback is configured, and there is no route off the container.
        addresses = _raw(sandbox, "ip", "-o", "addr", "show", "scope", "global")
        assert addresses.stdout.strip() == "", f"routable address present: {addresses.stdout}"

        routes = _raw(sandbox, "ip", "route", "show")
        assert routes.stdout.strip() == "", f"route present: {routes.stdout}"

    def test_repository_mount_is_read_only(self, sandbox: DockerSandbox) -> None:
        result = _raw(sandbox, "touch", "/workspace/pwned")
        assert result.returncode != 0
        assert not (Path("/workspace") / "pwned").exists()

    def test_root_filesystem_is_read_only(self, sandbox: DockerSandbox) -> None:
        assert _raw(sandbox, "touch", "/evil").returncode != 0

    def test_has_no_docker_socket(self, sandbox: DockerSandbox) -> None:
        assert _raw(sandbox, "test", "-S", "/var/run/docker.sock").returncode != 0

    def test_cannot_gain_privileges(self, sandbox: DockerSandbox) -> None:
        # no-new-privileges plus cap-drop ALL: su must fail to become root.
        result = _raw(sandbox, "su", "-c", "id -u")
        assert result.returncode != 0 or result.stdout.strip() != "0"

    def test_ephemeral_workspace_does_not_alias_the_source(
        self, sandbox: DockerSandbox, demo_repo: Path
    ) -> None:
        # The container analyses a copy; the caller's repository is untouched.
        before = sorted(p.name for p in demo_repo.iterdir())
        _raw(sandbox, "touch", "/tmp/scratch")
        assert sorted(p.name for p in demo_repo.iterdir()) == before


class TestExecution:
    def test_lists_changed_files_between_commits(
        self, sandbox: DockerSandbox, demo_shas: tuple[str, str]
    ) -> None:
        base, head = demo_shas
        result = sandbox.run(git_changed_files(base, head))
        assert result.ok, result.stderr
        paths = {line.split("\t")[-1] for line in result.stdout_lines()}
        assert "src/client/config.js" in paths
        assert "src/client/receiptUpload.js" in paths

    def test_produces_a_real_diff(
        self, sandbox: DockerSandbox, demo_shas: tuple[str, str]
    ) -> None:
        base, head = demo_shas
        result = sandbox.run(git_diff(base, head, "src/client/config.js"))
        assert "AWS_SECRET_ACCESS_KEY" in result.stdout
        assert result.stdout.startswith("diff --git")

    def test_streams_output_as_it_is_produced(self, sandbox: DockerSandbox) -> None:
        chunks: list[str] = []
        result = sandbox.stream(
            search_literal("AWS_SECRET_ACCESS_KEY"), lambda c: chunks.append(c.text)
        )
        assert result.ok
        assert chunks, "expected streamed output"
        assert "".join(chunks) == result.stdout

    def test_reports_duration_and_exit_code(self, sandbox: DockerSandbox) -> None:
        result = sandbox.run(search_literal("a-string-that-does-not-occur-anywhere"))
        # ripgrep exits 1 when there are no matches; that is a real exit status,
        # not an error, and the UI shows it as such.
        assert result.exit_code == 1
        assert result.duration_ms >= 0

    def test_refuses_a_command_outside_the_allowlist(self, sandbox: DockerSandbox) -> None:
        from netra_investigator.sandbox import CommandDenied

        with pytest.raises(CommandDenied):
            sandbox.run(SandboxCommand(argv=("sh", "-c", "cat /etc/passwd"), tool="evil"))
