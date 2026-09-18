"""Shared helpers for the investigator test suite."""

import shutil
import subprocess

import pytest


def docker_available() -> bool:
    try:
        return (
            subprocess.run(
                ["docker", "info"], capture_output=True, timeout=15, check=False
            ).returncode
            == 0
        )
    except (OSError, subprocess.TimeoutExpired):
        return False


requires_docker = pytest.mark.skipif(
    not docker_available(), reason="Docker is not available on this machine"
)


def has_ripgrep() -> bool:
    """Whether ripgrep is on PATH.

    The investigator image installs it; a developer machine may not have it.
    Tests that need it skip rather than fail, the same way the Docker tests do.
    """
    return shutil.which("rg") is not None


requires_ripgrep = pytest.mark.skipif(
    not has_ripgrep(),
    reason="ripgrep is not installed (the investigator container provides it)",
)
