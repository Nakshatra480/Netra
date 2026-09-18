import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_BUILDER = REPO_ROOT / "demo" / "vulnerable-repo" / "build-fixture.sh"


@pytest.fixture(scope="session")
def demo_repo() -> Path:
    """A real git repository containing the baseline and the risky change."""
    tmp = Path(tempfile.mkdtemp(prefix="netra-fixture-"))
    dest = tmp / "orbital-payments"
    subprocess.run([str(FIXTURE_BUILDER), str(dest)], check=True, capture_output=True)
    yield dest
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture(scope="session")
def demo_shas(demo_repo: Path) -> tuple[str, str]:
    """(base_sha, head_sha) of the demo repository."""
    out = subprocess.run(
        ["git", "-C", str(demo_repo), "log", "--reverse", "--format=%H"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    return out[0], out[1]
