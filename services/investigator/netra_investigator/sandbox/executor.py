"""Where an allowlisted command actually runs.

Netra analyses untrusted repositories, so every command runs inside an
isolation boundary. *Which* boundary depends on where Netra itself is running:

* **Locally**, `DockerSandbox` starts a container per investigation. Netra is a
  developer's process on a shared machine, so the container is the boundary.

* **On AWS Fargate**, `TaskSandbox` runs commands in the task's own container.
  Fargate cannot run Docker inside a task -- there is no daemon, no socket and
  no privileged mode -- so nesting a second container is not merely undesirable,
  it is impossible. The task itself is the boundary instead: one ephemeral task
  per investigation, non-root, read-only image, minimal IAM, destroyed when the
  investigation ends.

Both are equally governed by the allowlist, which is the control that actually
matters: the model emits a tool name and typed arguments, never a command. The
boundary limits the blast radius if a *tool* misbehaves; the allowlist is what
stops a model reaching a shell at all.
"""

from __future__ import annotations

import contextlib
import logging
import os
import resource
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from types import TracebackType
from typing import Protocol, runtime_checkable

from .allowlist import SandboxCommand, assert_permitted
from .docker_sandbox import (
    MAX_OUTPUT_BYTES,
    CommandResult,
    OutputChunk,
    SandboxError,
    SandboxLimits,
)

logger = logging.getLogger(__name__)


@runtime_checkable
class SandboxExecutor(Protocol):
    """Executes allowlisted commands against a prepared repository."""

    def start(self) -> None: ...
    def stop(self) -> None: ...
    def stream(
        self, command: SandboxCommand, on_output: Callable[[OutputChunk], None]
    ) -> CommandResult: ...
    def run(self, command: SandboxCommand) -> CommandResult: ...


class TaskSandbox:
    """Runs commands inside the current task's container.

    Used where the surrounding compute is already a single-purpose, ephemeral,
    unprivileged container. The workspace is a private copy pinned to the commit
    under investigation, and each command is bounded by CPU time, address space,
    process count, wall-clock time and output size.
    """

    #: Environment stripped from every command. Analysis has no business
    #: reading Netra's own credentials, and a git subprocess should not be able
    #: to pick up AWS or model-provider configuration from the environment.
    _STRIPPED_PREFIXES = ("AWS_", "OPENROUTER_", "OLLAMA_", "NETRA_", "GITHUB_")

    def __init__(
        self,
        repo_path: Path,
        *,
        limits: SandboxLimits | None = None,
        checkout: str | None = None,
    ) -> None:
        self._source_repo = repo_path
        self._limits = limits or SandboxLimits()
        self._checkout = checkout
        self._workdir: Path | None = None
        self._workspace: Path | None = None

    def __enter__(self) -> TaskSandbox:
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.stop()

    @property
    def workspace(self) -> Path:
        if self._workspace is None:
            raise SandboxError("sandbox is not running")
        return self._workspace

    def start(self) -> None:
        if self._workspace is not None:
            raise SandboxError("sandbox already started")
        if not (self._source_repo / ".git").is_dir():
            raise SandboxError(f"not a git repository: {self._source_repo}")

        self._workdir = Path(tempfile.mkdtemp(prefix="netra-task-"))
        workspace = self._workdir / "workspace"
        # An ephemeral copy: analysis can never mutate the caller's repository.
        shutil.copytree(self._source_repo, workspace, symlinks=False)

        if self._checkout is not None:
            # Pin to the commit under investigation, so analysis describes a
            # specific commit rather than whatever was checked out.
            result = subprocess.run(
                ["git", "-C", str(workspace), "checkout", "--quiet", "--detach", self._checkout],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            if result.returncode != 0:
                self.stop()
                raise SandboxError(
                    f"could not check out {self._checkout}: {result.stderr.strip()[:300]}"
                )

        self._workspace = workspace
        logger.info("task sandbox ready", extra={"workspace": str(workspace)})

    def stop(self) -> None:
        if self._workdir and self._workdir.exists():
            shutil.rmtree(self._workdir, ignore_errors=True)
        self._workdir = None
        self._workspace = None

    def run(self, command: SandboxCommand) -> CommandResult:
        return self.stream(command, lambda _chunk: None)

    def stream(
        self, command: SandboxCommand, on_output: Callable[[OutputChunk], None]
    ) -> CommandResult:
        assert_permitted(command)
        if self._workspace is None:
            raise SandboxError("sandbox is not running")

        # Commands are written against the container's mount point; here the
        # workspace is a real directory, so the path is rewritten rather than
        # the allowlist being loosened.
        workspace = str(self._workspace)
        argv = [
            workspace if arg == "/workspace" else arg.replace("/workspace/", f"{workspace}/")
            for arg in command.argv
        ]

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
            cwd=str(self._workspace),
            env=self._child_env(),
            preexec_fn=self._apply_limits,  # noqa: PLW1509 - bounding an untrusted child
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
        return CommandResult(
            command=command,
            exit_code=exit_code,
            stdout="".join(stdout_parts),
            stderr="".join(stderr_parts),
            duration_ms=int((time.monotonic() - started) * 1000),
            timed_out=timed_out,
            truncated=truncated,
        )

    def _child_env(self) -> dict[str, str]:
        """A minimal environment for the analysis process."""
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(self._STRIPPED_PREFIXES)
        }
        # git must not read the invoking user's configuration, and must never
        # be able to prompt for credentials.
        env.update(
            {
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_OPTIONAL_LOCKS": "0",
                "HOME": str(self._workdir) if self._workdir else "/tmp",  # noqa: S108
            }
        )
        return env

    def _apply_limits(self) -> None:
        """Bound the child process. Runs between fork and exec.

        Each limit is applied independently and failures are ignored. These are
        defence in depth behind the allowlist and the wall-clock timeout the
        parent enforces; a platform that refuses one of them must not stop the
        investigation from running.

        RLIMIT_NPROC is deliberately not set: on some platforms it counts every
        process owned by the user, so a sensible-looking value would make the
        analysis fail for reasons that have nothing to do with the analysis.
        """
        # A new process group first, so a runaway child tree can be killed as a
        # unit even if a later limit cannot be applied.
        _try(os.setsid)

        cpu_seconds = max(1, int(self._limits.command_timeout_s))
        _try(resource.setrlimit, resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 5))
        _try(resource.setrlimit, resource.RLIMIT_FSIZE, (_MAX_FILE_BYTES, _MAX_FILE_BYTES))

        # Address space is capped generously: git and ripgrep memory-map files,
        # so a tight ceiling fails ordinary analysis rather than catching abuse.
        memory_bytes = max(self._limits.memory_mb, 1024) * 1024 * 1024
        _try(resource.setrlimit, resource.RLIMIT_AS, (memory_bytes, memory_bytes))


#: Ceiling on any single file an analysis command may write.
_MAX_FILE_BYTES = 64 * 1024 * 1024


def _try(fn, *args) -> None:
    """Apply a best-effort limit, ignoring platforms that refuse it.

    Nothing is logged: this runs between fork and exec, where the child must do
    as little as possible.
    """
    with contextlib.suppress(OSError, ValueError):
        fn(*args)


def _interleave(proc: subprocess.Popen[str]):
    if proc.stdout is not None:
        for line in proc.stdout:
            yield "stdout", line
    if proc.stderr is not None:
        for line in proc.stderr:
            yield "stderr", line


__all__ = ["SandboxExecutor", "TaskSandbox"]
