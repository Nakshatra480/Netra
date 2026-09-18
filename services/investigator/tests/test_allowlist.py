"""The allowlist is the boundary between model output and command execution."""

import pytest

from netra_investigator.sandbox.allowlist import (
    CommandDenied,
    assert_permitted,
    find_references,
    git_diff,
    git_log,
    read_file,
    search_literal,
    validate_path,
)


class TestPathValidation:
    @pytest.mark.parametrize(
        "path",
        [
            "../../etc/passwd",
            "/etc/passwd",
            "src/../../secrets",
            "-rf",
            "src/config.ts; rm -rf /",
            "src/$(whoami)",
            "src/`id`",
            "a" * 500,
            "src/\x00evil",
        ],
    )
    def test_rejects_unsafe_paths(self, path: str) -> None:
        with pytest.raises(CommandDenied):
            validate_path(path)

    @pytest.mark.parametrize("path", ["src/config.ts", "src", ".", "a/b/c-d_e.json"])
    def test_accepts_repository_relative_paths(self, path: str) -> None:
        assert validate_path(path) == path


class TestSearchCommands:
    def test_search_is_always_a_literal_match(self) -> None:
        # A query that would be a catastrophic regex must be treated as text.
        cmd = search_literal("(a+)+$")
        assert "--fixed-strings" in cmd.argv
        assert cmd.argv[-2] == "(a+)+$"

    def test_query_and_path_cannot_become_flags(self) -> None:
        # `--` separates options from operands, so a leading dash is an operand.
        cmd = search_literal("--version")
        assert cmd.argv.index("--") < cmd.argv.index("--version")

    def test_rejects_control_characters(self) -> None:
        with pytest.raises(CommandDenied):
            search_literal("AWS\nSECRET")

    def test_rejects_oversized_query(self) -> None:
        with pytest.raises(CommandDenied):
            search_literal("x" * 500)

    def test_symbol_reference_search_rejects_punctuation(self) -> None:
        with pytest.raises(CommandDenied):
            find_references("process.env['X']")


class TestGitCommands:
    def test_diff_requires_real_shas(self) -> None:
        with pytest.raises(CommandDenied):
            git_diff("HEAD", "main")
        with pytest.raises(CommandDenied):
            git_diff("abc1234", "--upload-pack=evil")

    def test_diff_accepts_commit_shas(self) -> None:
        cmd = git_diff("abc1234", "def5678")
        assert cmd.argv[0] == "git"
        assert "diff" in cmd.argv

    def test_log_bounds_the_result_count(self) -> None:
        with pytest.raises(CommandDenied):
            git_log(limit=10_000)

    def test_read_file_bounds_line_count(self) -> None:
        with pytest.raises(CommandDenied):
            read_file("src/a.ts", max_lines=999_999)


class TestFinalGate:
    def test_only_allowlisted_binaries_reach_execution(self) -> None:
        from netra_investigator.sandbox.allowlist import Binary, SandboxCommand

        assert_permitted(SandboxCommand(argv=("git", "status"), tool="t"))
        with pytest.raises(CommandDenied):
            assert_permitted(SandboxCommand(argv=("sh", "-c", "id"), tool="t"))
        with pytest.raises(CommandDenied):
            assert_permitted(SandboxCommand(argv=("curl", "http://evil"), tool="t"))
        with pytest.raises(CommandDenied):
            assert_permitted(SandboxCommand(argv=(), tool="t"))
        assert Binary.GIT.value in {"git"}
