"""Structured investigation tools.

This is the only surface the agent is given. Each tool takes typed parameters,
routes them through the allowlist, executes the resulting command in the
sandbox, streams its output to the investigation terminal, and returns a
*structured* result. The agent never sees a shell and never supplies a command.

    agent -> tool -> allowlist -> sandbox -> command
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import PurePosixPath

from ..events import EventEmitter, new_id
from ..sandbox import CommandDenied, CommandResult, DockerSandbox
from ..sandbox.allowlist import (
    SandboxCommand,
    find_references,
    git_changed_files,
    git_diff,
    git_log,
    list_files,
    read_file,
    search_literal,
)

logger = logging.getLogger(__name__)

#: Bound on how much of a file a tool will return to the agent, keeping model
#: context (and cost) predictable regardless of repository size.
MAX_FILE_LINES = 400
MAX_MATCHES = 100


@dataclass(frozen=True, slots=True)
class Match:
    """One search hit, with enough context to become evidence."""

    file: str
    line: int
    text: str


@dataclass(frozen=True, slots=True)
class ChangedFile:
    path: str
    change_type: str


@dataclass(slots=True)
class ToolCallRecord:
    """What a tool did, retained so evidence can cite the exact command."""

    tool: str
    command: str
    exit_code: int
    duration_ms: int


_CHANGE_TYPES = {"A": "ADDED", "M": "MODIFIED", "D": "DELETED", "R": "RENAMED"}


class InvestigationTools:
    """Tool implementations bound to one sandbox and one investigation."""

    def __init__(
        self,
        sandbox: DockerSandbox,
        emitter: EventEmitter,
        base_sha: str,
        head_sha: str,
    ) -> None:
        self._sandbox = sandbox
        self._emitter = emitter
        self._base_sha = base_sha
        self._head_sha = head_sha
        self.calls: list[ToolCallRecord] = []

    # -- execution ---------------------------------------------------------

    def _execute(self, command: SandboxCommand) -> CommandResult:
        """Run a command, streaming its output to the investigation terminal."""
        command_id = new_id("cmd")
        self._emitter.command_started(command_id, command.tool, command.rendered)

        def on_output(chunk) -> None:  # noqa: ANN001 - OutputChunk
            self._emitter.command_output(command_id, chunk.stream, chunk.text)

        result = self._sandbox.stream(command, on_output)
        self._emitter.command_finished(
            command_id, result.exit_code, result.duration_ms, result.timed_out
        )
        self.calls.append(
            ToolCallRecord(
                tool=command.tool,
                command=command.rendered,
                exit_code=result.exit_code,
                duration_ms=result.duration_ms,
            )
        )
        return result

    # -- tools -------------------------------------------------------------

    def inspect_diff(self, path: str | None = None) -> str:
        """Return the unified diff of the change, optionally for one path."""
        return self._execute(git_diff(self._base_sha, self._head_sha, path)).stdout

    def changed_files(self) -> list[ChangedFile]:
        """List the files this change touched."""
        result = self._execute(git_changed_files(self._base_sha, self._head_sha))
        changed: list[ChangedFile] = []
        for line in result.stdout_lines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            status = parts[0][0]
            changed.append(
                ChangedFile(
                    path=normalize_path(parts[-1]),
                    change_type=_CHANGE_TYPES.get(status, "MODIFIED"),
                )
            )
        return changed

    def search_repository(self, query: str, path: str = ".") -> list[Match]:
        """Search the repository for a literal string."""
        return self._parse_matches(self._execute(search_literal(query, path)))

    def find_references(self, symbol: str, path: str = ".") -> list[Match]:
        """Find whole-word references to an identifier."""
        return self._parse_matches(self._execute(find_references(symbol, path)))

    def read_file(self, path: str, max_lines: int = MAX_FILE_LINES) -> list[str]:
        """Read a bounded number of lines from a file."""
        result = self._execute(read_file(path, max_lines))
        if not result.ok:
            return []
        return result.stdout.splitlines()[:max_lines]

    def list_files(self, path: str = ".") -> list[str]:
        """List the repository's tracked files under a path."""
        return [normalize_path(p) for p in self._execute(list_files(path)).stdout_lines()]

    def inspect_git_history(self, path: str | None = None, limit: int = 10) -> list[str]:
        """Show recent commits, optionally for one path."""
        return self._execute(git_log(path, limit)).stdout_lines()

    # -- parsing -----------------------------------------------------------

    @staticmethod
    def _parse_matches(result: CommandResult) -> list[Match]:
        """Parse ripgrep's `file:line:text` output.

        Exit code 1 means "no matches", which is a valid answer rather than an
        error; any other non-zero status means the search itself failed.
        """
        if result.exit_code not in (0, 1):
            logger.warning("search failed: %s", result.stderr.strip()[:200])
            return []
        matches: list[Match] = []
        for line in result.stdout_lines()[:MAX_MATCHES]:
            parts = line.split(":", 2)
            if len(parts) != 3 or not parts[1].isdigit():
                continue
            matches.append(
                Match(file=normalize_path(parts[0]), line=int(parts[1]), text=parts[2].strip())
            )
        return matches


def normalize_path(path: str) -> str:
    """Canonical repository-relative form of a path.

    Tools report paths differently -- ripgrep prefixes `./` when searching the
    tree, git does not -- and reachability analysis compares paths as strings.
    Normalising once here means every tool speaks the same path language.
    """
    cleaned = path.strip()
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned.removeprefix("/workspace/")


def is_within(path: str, root: str) -> bool:
    """True when `path` lies inside `root`, by path segments rather than prefix."""
    if root in ("", "."):
        return True
    try:
        PurePosixPath(path).relative_to(PurePosixPath(root))
    except ValueError:
        return False
    return True


__all__ = [
    "ChangedFile",
    "CommandDenied",
    "InvestigationTools",
    "Match",
    "ToolCallRecord",
    "is_within",
    "normalize_path",
]
