"""Isolated execution of allowlisted repository-analysis commands.

Repository contents are untrusted input. Every command runs inside a container
that has no network, no privileges, a read-only mount of an ephemeral copy of
the repository, and hard CPU/memory/PID/time limits. The container never
receives the Docker socket, never runs as root, and is destroyed when the
investigation ends.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType

from .allowlist import SandboxCommand, assert_permitted

logger = logging.getLogger(__name__)

#: uid:gid the analysis process runs as. Matches the image's `netra` user.
SANDBOX_USER = "10001:10001"
DEFAULT_IMAGE = "netra-sandbox:latest"
DEFAULT_TIMEOUT_S = 30.0
MAX_OUTPUT_BYTES = 256 * 1024


class SandboxError(RuntimeError):
    """The sandbox could not be prepared or a command could not be executed."""


@dataclass(frozen=True, slots=True)
class SandboxLimits:
    memory_mb: int = 512
    cpus: str = "1.0"
    pids: int = 128
    command_timeout_s: float = DEFAULT_TIMEOUT_S


@dataclass(slots=True)
class CommandResult:
    command: SandboxCommand
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    truncated: bool

    @property
    def ok(self) -> bool:
        return self.exit_code == 0

    def stdout_lines(self) -> list[str]:
        return [line for line in self.stdout.splitlines() if line]


@dataclass(slots=True)
class OutputChunk:
    """A piece of command output, streamed to the UI as it is produced."""

    stream: str  # "stdout" | "stderr"
    text: str


class DockerSandbox:
    """A single long-lived, locked-down container for one investigation.

    The container is started with a no-op entrypoint and kept alive so that
    successive analysis commands are fast; each command is executed with
    `docker exec` using an argv list, so no shell ever interprets an argument.
    """

    def __init__(
        self,
        repo_path: Path,
        *,
        image: str = DEFAULT_IMAGE,
        limits: SandboxLimits | None = None,
        checkout: str | None = None,
    ) -> None:
        self._source_repo = repo_path
        self._image = image
        self._limits = limits or SandboxLimits()
        #: Commit the ephemeral workspace is pinned to. Analysis must describe a
        #: specific commit, not whatever happened to be in the working tree.
        self._checkout = checkout
        self._container_id: str | None = None
        self._workdir: Path | None = None

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> DockerSandbox:
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.stop()

    def start(self) -> None:
        """Copy the repository to an ephemeral workspace and start the container."""
        if self._container_id is not None:
            raise SandboxError("sandbox already started")
        if not (self._source_repo / ".git").is_dir():
            raise SandboxError(f"not a git repository: {self._source_repo}")

        self._workdir = Path(tempfile.mkdtemp(prefix="netra-sandbox-"))
        workspace = self._workdir / "workspace"
        # An ephemeral copy: analysis can never mutate the caller's repository,
        # and the copy is removed with the container.
        shutil.copytree(self._source_repo, workspace, symlinks=False)

        if self._checkout is not None:
            # Pin the copy before it is mounted, because the mount is read-only
            # and nothing inside the container may alter the tree.
            checkout = subprocess.run(
                ["git", "-C", str(workspace), "checkout", "--quiet", "--detach", self._checkout],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if checkout.returncode != 0:
                self._cleanup_workdir()
                raise SandboxError(
                    f"could not check out {self._checkout}: {checkout.stderr.strip()}"
                )

        name = f"netra-inv-{uuid.uuid4().hex[:12]}"
        argv = [
            "docker", "run", "--detach", "--rm",
            "--name", name,
            # No network: analysis must not reach the internet or the host.
            "--network", "none",
            "--user", SANDBOX_USER,
            "--read-only",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--memory", f"{self._limits.memory_mb}m",
            "--memory-swap", f"{self._limits.memory_mb}m",
            "--cpus", self._limits.cpus,
            "--pids-limit", str(self._limits.pids),
            # Writable scratch only; nothing persists beyond the container.
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",  # noqa: S108 - a tmpfs inside the container, not a host path
            # The repository is mounted read-only: no analysis step may alter it.
            "--volume", f"{workspace}:/workspace:ro",
            "--workdir", "/workspace",
            self._image,
            "sleep", "3600",
        ]
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=120, check=False)
        except subprocess.TimeoutExpired as err:  # pragma: no cover - environment failure
            self._cleanup_workdir()
            raise SandboxError("timed out starting the sandbox container") from err
        if proc.returncode != 0:
            self._cleanup_workdir()
            raise SandboxError(f"could not start sandbox: {proc.stderr.strip()}")

        self._container_id = proc.stdout.strip()
        logger.info("sandbox started", extra={"container": name, "image": self._image})

    def stop(self) -> None:
        """Destroy the container and the ephemeral workspace."""
        if self._container_id:
            subprocess.run(
                ["docker", "kill", self._container_id],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self._container_id = None
        self._cleanup_workdir()

    def _cleanup_workdir(self) -> None:
        if self._workdir and self._workdir.exists():
            shutil.rmtree(self._workdir, ignore_errors=True)
        self._workdir = None

    # -- execution ---------------------------------------------------------

    def run(self, command: SandboxCommand) -> CommandResult:
        """Execute an allowlisted command and return its complete result."""
        chunks: list[OutputChunk] = []
        result = self.stream(command, chunks.append)
        return result

    def stream(
        self,
        command: SandboxCommand,
        on_output: Callable[[OutputChunk], None],
    ) -> CommandResult:
        """Execute a command, delivering output to `on_output` as it arrives.

        Output is bounded: once MAX_OUTPUT_BYTES have been delivered the command
        is terminated and the result is marked truncated, so a hostile
        repository cannot exhaust memory through a pathological file.
        """
        assert_permitted(command)
        if self._container_id is None:
            raise SandboxError("sandbox is not running")

        argv = ["docker", "exec", self._container_id, *command.argv]
        started = time.monotonic()
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        delivered = 0
        truncated = False
        timed_out = False

        with subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        ) as proc:
            try:
                for stream_name, line in _interleave(proc):
                    if delivered >= MAX_OUTPUT_BYTES:
                        truncated = True
                        proc.kill()
                        break
                    if time.monotonic() - started > self._limits.command_timeout_s:
                        timed_out = True
                        proc.kill()
                        break
                    delivered += len(line)
                    (stdout_parts if stream_name == "stdout" else stderr_parts).append(line)
                    on_output(OutputChunk(stream=stream_name, text=line))
                exit_code = proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                timed_out = True
                exit_code = 124
            except Exception:
                proc.kill()
                raise

        if timed_out:
            exit_code = 124
        duration_ms = int((time.monotonic() - started) * 1000)
        return CommandResult(
            command=command,
            exit_code=exit_code,
            stdout="".join(stdout_parts),
            stderr="".join(stderr_parts),
            duration_ms=duration_ms,
            timed_out=timed_out,
            truncated=truncated,
        )


def _interleave(proc: subprocess.Popen[str]) -> Iterator[tuple[str, str]]:
    """Yield (stream, line) pairs, reading stdout to completion then stderr.

    Analysis commands are short and write predominantly to one stream, so a
    reader thread per stream would add complexity without changing what the user
    sees. stderr is drained after stdout so failures are never lost.
    """
    if proc.stdout is not None:
        for line in proc.stdout:
            yield "stdout", line
    if proc.stderr is not None:
        for line in proc.stderr:
            yield "stderr", line

