"""What a change actually touched.

The report's "Files changed / Lines added / Lines removed" row is only
meaningful if the numbers are measured. `git diff --name-status` says what
happened to each file but not how much, so the counts come from a second
`--numstat` pass keyed by path.
"""

from __future__ import annotations

from dataclasses import dataclass

from netra_investigator.tools.runtime import ChangedFile, InvestigationTools


@dataclass
class FakeResult:
    stdout: str

    def stdout_lines(self) -> list[str]:
        return [line for line in self.stdout.splitlines() if line]


class FakeTools(InvestigationTools):
    """Drives the real parsing against canned git output."""

    def __init__(self, name_status: str, numstat: str) -> None:
        self._name_status = name_status
        self._numstat = numstat
        self._base_sha = "a" * 40
        self._head_sha = "b" * 40
        self.calls: list[str] = []

    def _execute(self, command):  # noqa: ANN001, ANN202
        rendered = " ".join(command.argv)
        self.calls.append(rendered)
        return FakeResult(self._numstat if "--numstat" in rendered else self._name_status)


NAME_STATUS = "A\tsrc/client/payment.js\nM\tsrc/client/main.js\nD\tsrc/old.js\n"
NUMSTAT = "38\t0\tsrc/client/payment.js\n2\t1\tsrc/client/main.js\n0\t12\tsrc/old.js\n"


class TestMeasuredLineCounts:
    def test_each_file_carries_the_counts_git_reported(self) -> None:
        files = FakeTools(NAME_STATUS, NUMSTAT).changed_files()

        by_path = {f.path: f for f in files}
        assert by_path["src/client/payment.js"].additions == 38
        assert by_path["src/client/payment.js"].deletions == 0
        assert by_path["src/client/main.js"].additions == 2
        assert by_path["src/client/main.js"].deletions == 1
        assert by_path["src/old.js"].deletions == 12

    def test_change_type_still_comes_from_name_status(self) -> None:
        by_path = {f.path: f for f in FakeTools(NAME_STATUS, NUMSTAT).changed_files()}
        assert by_path["src/client/payment.js"].change_type == "ADDED"
        assert by_path["src/client/main.js"].change_type == "MODIFIED"
        assert by_path["src/old.js"].change_type == "DELETED"

    def test_a_binary_file_has_no_line_count_rather_than_zero(self) -> None:
        # git prints "-" for a binary file. Zero would be a measurement;
        # this is the absence of one.
        files = FakeTools("A\tlogo.png\n", "-\t-\tlogo.png\n").changed_files()
        assert files[0].additions is None
        assert files[0].deletions is None

    def test_a_file_missing_from_numstat_is_still_listed(self) -> None:
        files = FakeTools("M\tsrc/a.js\n", "").changed_files()
        assert [f.path for f in files] == ["src/a.js"]
        assert files[0].additions is None

    def test_counts_are_unavailable_rather_than_fatal_when_git_fails(self) -> None:
        class Failing(FakeTools):
            def _execute(self, command):  # noqa: ANN001, ANN202
                rendered = " ".join(command.argv)
                if "--numstat" in rendered:
                    raise RuntimeError("numstat unavailable")
                return FakeResult(NAME_STATUS)

        # Line counts are detail. Losing them must not lose the file list,
        # which the analyzer depends on.
        files = Failing(NAME_STATUS, "").changed_files()
        assert len(files) == 3
        assert all(f.additions is None for f in files)

    def test_both_git_passes_are_made(self) -> None:
        tools = FakeTools(NAME_STATUS, NUMSTAT)
        tools.changed_files()
        assert any("--numstat" in c for c in tools.calls)
        assert any("--name-status" in c for c in tools.calls)


class TestChangedFileDefaults:
    def test_counts_default_to_unknown(self) -> None:
        # A ChangedFile built without counts must not imply it measured zero.
        f = ChangedFile(path="a.js", change_type="MODIFIED")
        assert f.additions is None
        assert f.deletions is None
