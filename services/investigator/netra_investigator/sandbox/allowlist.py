"""The command allowlist enforced between the agent and the sandbox.

Netra never executes a string produced by a language model. The agent selects a
*tool*, the tool produces a structured request, and this module is the only
place that turns a request into an argv list. Every argument is validated
against an explicit rule, so an argument can never become a flag, a shell
metacharacter, or a path outside the workspace.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

#: Absolute path the repository is mounted at inside the container.
WORKSPACE = "/workspace"

MAX_QUERY_LENGTH = 200
MAX_PATH_LENGTH = 400
MAX_RESULTS = 200


class CommandDenied(ValueError):
    """Raised when a requested command violates the allowlist."""


class Binary(str, Enum):
    """The only executables the sandbox may ever run."""

    GIT = "git"
    RIPGREP = "rg"
    CAT = "cat"
    FIND = "find"


#: Unresolved repository-relative path. Rejects absolute paths, parent
#: traversal, shell metacharacters, NUL bytes and leading dashes.
_SAFE_PATH = re.compile(r"^(?!-)[A-Za-z0-9._][A-Za-z0-9._/\-]*$")
_SAFE_SHA = re.compile(r"^[0-9a-f]{7,40}$")
_SAFE_SYMBOL = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-]*$")


def validate_path(path: str) -> str:
    """Validate a repository-relative path, or '.' for the repository root."""
    if path in ("", "."):
        return "."
    if len(path) > MAX_PATH_LENGTH:
        raise CommandDenied(f"path exceeds {MAX_PATH_LENGTH} characters")
    if not _SAFE_PATH.match(path):
        raise CommandDenied(f"unsafe path: {path!r}")
    # Defence in depth: the regex already excludes '..', but paths are the one
    # argument class where a miss would escape the workspace.
    if ".." in path.split("/"):
        raise CommandDenied("path traversal is not permitted")
    return path


def validate_sha(sha: str) -> str:
    if not _SAFE_SHA.match(sha):
        raise CommandDenied(f"not a commit sha: {sha!r}")
    return sha


def validate_symbol(symbol: str) -> str:
    """Validate an identifier such as an environment variable name."""
    if not _SAFE_SYMBOL.match(symbol) or len(symbol) > MAX_QUERY_LENGTH:
        raise CommandDenied(f"unsafe symbol: {symbol!r}")
    return symbol


def validate_literal_query(query: str) -> str:
    """Validate a literal (non-regex) search string.

    Searches always run with ripgrep's --fixed-strings, so the query is never
    interpreted as a pattern. We still bound its length and reject control
    characters so that output stays parseable.
    """
    if not query or len(query) > MAX_QUERY_LENGTH:
        raise CommandDenied("query must be between 1 and 200 characters")
    if any(ord(c) < 32 for c in query):
        raise CommandDenied("query must not contain control characters")
    return query


@dataclass(frozen=True, slots=True)
class SandboxCommand:
    """A fully-validated command ready for execution in the sandbox."""

    argv: tuple[str, ...]
    #: Identifier of the tool contract that produced this command.
    tool: str

    @property
    def rendered(self) -> str:
        """The command as shown in the investigation terminal."""
        return " ".join(_render_arg(a) for a in self.argv)


def _render_arg(arg: str) -> str:
    return f"'{arg}'" if " " in arg or not arg else arg


def _command(tool: str, binary: Binary, *args: str) -> SandboxCommand:
    return SandboxCommand(argv=(binary.value, *args), tool=tool)


# --- Command builders -------------------------------------------------------
# Each builder is the only route to its binary. Callers pass typed values; the
# builder validates them and returns an argv tuple that no longer contains any
# caller-controlled structure.


def git_changed_files(base_sha: str, head_sha: str) -> SandboxCommand:
    """List paths changed between two commits."""
    return _command(
        "inspect_diff",
        Binary.GIT,
        "--no-optional-locks",
        "-C",
        WORKSPACE,
        "diff",
        "--name-status",
        "--no-color",
        validate_sha(base_sha),
        validate_sha(head_sha),
    )


def git_diff(base_sha: str, head_sha: str, path: str | None = None) -> SandboxCommand:
    """Show the unified diff between two commits, optionally scoped to a path."""
    args = [
        "--no-optional-locks",
        "-C",
        WORKSPACE,
        "diff",
        "--no-color",
        "--unified=3",
        validate_sha(base_sha),
        validate_sha(head_sha),
    ]
    if path:
        args += ["--", validate_path(path)]
    return _command("inspect_diff", Binary.GIT, *args)


def git_log(path: str | None = None, limit: int = 10) -> SandboxCommand:
    """Show recent history, optionally for a single path."""
    if not 1 <= limit <= 50:
        raise CommandDenied("limit must be between 1 and 50")
    args = [
        "--no-optional-locks",
        "-C",
        WORKSPACE,
        "log",
        "--no-color",
        f"--max-count={limit}",
        "--date=short",
        "--pretty=format:%h %ad %an %s",
    ]
    if path:
        args += ["--", validate_path(path)]
    return _command("inspect_git_history", Binary.GIT, *args)


def search_literal(query: str, path: str = ".") -> SandboxCommand:
    """Search the repository for a literal string."""
    return _command(
        "search_repository",
        Binary.RIPGREP,
        "--fixed-strings",
        "--line-number",
        "--no-heading",
        "--color=never",
        "--max-count=20",
        f"--max-columns={MAX_RESULTS}",
        "--",
        validate_literal_query(query),
        validate_path(path),
    )


def find_references(symbol: str, path: str = ".") -> SandboxCommand:
    """Find references to an identifier as a whole word."""
    return _command(
        "find_references",
        Binary.RIPGREP,
        "--fixed-strings",
        "--word-regexp",
        "--line-number",
        "--no-heading",
        "--color=never",
        "--max-count=20",
        "--",
        validate_symbol(symbol),
        validate_path(path),
    )


def read_file(path: str, max_lines: int = 400) -> SandboxCommand:
    """Read a bounded number of lines from a file."""
    if not 1 <= max_lines <= 2000:
        raise CommandDenied("max_lines must be between 1 and 2000")
    # `cat` cannot bound its own output, so the executor truncates instead; the
    # bound is enforced by the caller reading at most max_lines.
    return _command("read_file", Binary.CAT, "--", f"{WORKSPACE}/{validate_path(path)}")


def list_files(path: str = ".") -> SandboxCommand:
    """List tracked files under a path."""
    return _command(
        "list_files",
        Binary.GIT,
        "--no-optional-locks",
        "-C",
        WORKSPACE,
        "ls-files",
        "--",
        validate_path(path),
    )


#: Binaries that may appear as argv[0]. The executor re-checks this immediately
#: before invoking Docker, so a builder bug cannot introduce a new binary.
PERMITTED_BINARIES = frozenset(b.value for b in Binary)


def assert_permitted(command: SandboxCommand) -> None:
    """Final gate before execution."""
    if not command.argv:
        raise CommandDenied("empty command")
    if command.argv[0] not in PERMITTED_BINARIES:
        raise CommandDenied(f"binary not permitted: {command.argv[0]!r}")
    for arg in command.argv:
        if "\x00" in arg:
            raise CommandDenied("argument contains a NUL byte")
