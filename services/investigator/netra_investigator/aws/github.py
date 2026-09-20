"""Fetching the repository under investigation.

Netra clones with a GitHub App *installation* token, not a personal one. The
token is minted per investigation from the App's private key, is scoped to the
installation's repositories, and expires within the hour -- so a leaked clone
credential is worth very little and cannot reach anything the App was not
installed on.

The token is never written to disk, never placed in a remote URL that git might
persist, and never logged.
"""

from __future__ import annotations

import base64
import contextlib
import json
import logging
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
USER_AGENT = "Netra-Investigator/0.1"


class GitHubUnavailable(RuntimeError):
    """GitHub could not be reached, or refused the credential."""


@dataclass(frozen=True, slots=True)
class AppCredentials:
    app_id: str
    private_key: str

    @classmethod
    def from_secret(cls, payload: str) -> AppCredentials:
        data = json.loads(payload)
        if not data.get("appId") or not data.get("privateKey"):
            raise GitHubUnavailable("the GitHub App secret is missing appId or privateKey")
        return cls(app_id=str(data["appId"]), private_key=str(data["privateKey"]))


def mint_app_jwt(credentials: AppCredentials, *, now: int | None = None) -> str:
    """Sign a short-lived App JWT with the private key.

    Signed via openssl rather than a crypto dependency: the container already
    needs openssl, and the key never leaves a mode-600 file that exists for the
    duration of one signature.
    """
    issued = now if now is not None else int(time.time())

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    header = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    # Backdated 60s to tolerate clock skew; GitHub caps the lifetime at 10 min.
    payload = b64(
        json.dumps({"iat": issued - 60, "exp": issued + 300, "iss": credentials.app_id}).encode()
    )

    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=True) as key_file:
        Path(key_file.name).chmod(0o600)
        key_file.write(credentials.private_key)
        key_file.flush()
        try:
            signature = subprocess.run(
                ["openssl", "dgst", "-sha256", "-sign", key_file.name],
                input=f"{header}.{payload}".encode(),
                capture_output=True,
                check=True,
            ).stdout
        except subprocess.CalledProcessError as err:
            raise GitHubUnavailable("could not sign the App token") from err

    return f"{header}.{payload}.{b64(signature)}"


def installation_token(app_jwt: str, installation_id: int) -> str:
    """Exchange the App JWT for an installation token."""
    request = urllib.request.Request(  # noqa: S310 - fixed https GitHub endpoint
        f"{GITHUB_API}/app/installations/{installation_id}/access_tokens",
        data=b"",
        method="POST",
        headers={
            "authorization": f"Bearer {app_jwt}",
            "accept": "application/vnd.github+json",
            "user-agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return str(json.load(response)["token"])
    except urllib.error.HTTPError as err:
        # The status is useful; the body may echo the request, so it is dropped.
        raise GitHubUnavailable(
            f"GitHub refused an installation token (HTTP {err.code})"
        ) from None
    except (urllib.error.URLError, TimeoutError) as err:
        raise GitHubUnavailable(f"GitHub could not be reached: {err.reason}") from None


def clone_repository(
    full_name: str,
    token: str,
    destination: Path,
    *,
    commits: tuple[str, ...] = (),
    timeout_s: float = 300.0,
) -> Path:
    """Clone a repository, then ensure the commits under investigation exist.

    The token is passed through an askpass helper rather than embedded in the
    remote URL, because git records the remote in .git/config and a URL-embedded
    credential would persist into the workspace the analyzer later reads.
    """
    destination.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="netra-askpass-") as helper_dir:
        askpass = Path(helper_dir) / "askpass.sh"
        askpass.write_text(
            "#!/bin/sh\n"
            'case "$1" in\n'
            "*Username*) echo x-access-token ;;\n"
            '*) cat "$GIT_TOKEN_FILE" ;;\n'
            "esac\n"
        )
        askpass.chmod(0o700)

        token_file = Path(helper_dir) / "token"
        token_file.write_text(token)
        token_file.chmod(0o600)

        env = {
            "GIT_ASKPASS": str(askpass),
            "GIT_TOKEN_FILE": str(token_file),
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "HOME": helper_dir,
            "PATH": "/usr/bin:/bin:/usr/local/bin",
        }

        _git(
            ["clone", "--quiet", f"https://github.com/{full_name}.git", str(destination)],
            env=env,
            timeout_s=timeout_s,
        )

        # A default clone may not contain a pull request's head commit, and a
        # force-push can leave a base commit unreachable from any branch.
        for commit in {c for c in commits if c}:
            if not _has_commit(destination, commit):
                logger.info("fetching commit not present in the clone")
                _git(
                    ["-C", str(destination), "fetch", "--quiet", "origin", commit],
                    env=env,
                    timeout_s=timeout_s,
                    check=False,
                )

    return destination


def push_branch(
    token: str,
    repo_path: Path,
    branch: str,
    full_name: str,
    *,
    timeout_s: float = 120.0,
) -> None:
    """Force-push a local branch to GitHub using an installation token.

    The token is passed through the same askpass helper used by clone_repository,
    so it is never embedded in the remote URL or any git-tracked file.
    """
    with tempfile.TemporaryDirectory(prefix="netra-askpass-") as helper_dir:
        askpass = Path(helper_dir) / "askpass.sh"
        askpass.write_text(
            "#!/bin/sh\n"
            'case "$1" in\n'
            "*Username*) echo x-access-token ;;\n"
            '*) cat "$GIT_TOKEN_FILE" ;;\n'
            "esac\n"
        )
        askpass.chmod(0o700)

        token_file = Path(helper_dir) / "token"
        token_file.write_text(token)
        token_file.chmod(0o600)

        env = {
            "GIT_ASKPASS": str(askpass),
            "GIT_TOKEN_FILE": str(token_file),
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "HOME": helper_dir,
            "PATH": "/usr/bin:/bin:/usr/local/bin",
        }

        _git(
            [
                "-C", str(repo_path),
                "push", "--quiet", "--force-with-lease",
                f"https://github.com/{full_name}.git",
                f"HEAD:refs/heads/{branch}",
            ],
            env=env,
            timeout_s=timeout_s,
        )


def create_pull_request(
    token: str,
    full_name: str,
    *,
    head: str,
    base: str,
    title: str,
    body: str,
) -> str:
    """Open a pull request and return its html_url.

    Uses the GitHub REST API (POST /repos/{full_name}/pulls). The token is
    sent only in the Authorization header, never in the URL.
    """
    payload = json.dumps({"title": title, "body": body, "head": head, "base": base}).encode()
    request = urllib.request.Request(  # noqa: S310 – fixed https GitHub endpoint
        f"{GITHUB_API}/repos/{full_name}/pulls",
        data=payload,
        method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "accept": "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            data = json.load(response)
            html_url = str(data["html_url"])
            logger.info("pull request created", extra={"pr_url": html_url})
            return html_url
    except urllib.error.HTTPError as err:
        # The body is optional context for the error message; failing to read
        # it must not replace the HTTP failure with a less useful one.
        body_text = ""
        with contextlib.suppress(Exception):
            body_text = err.read().decode("utf-8", errors="replace")[:200]
        raise GitHubUnavailable(
            f"GitHub refused PR creation (HTTP {err.code}): {body_text}"
        ) from None
    except (urllib.error.URLError, TimeoutError) as err:
        raise GitHubUnavailable(f"GitHub could not be reached: {err}") from None


def _has_commit(repo: Path, commit: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "cat-file", "-e", f"{commit}^{{commit}}"],
        capture_output=True,
        timeout=30,
        check=False,
    )
    return result.returncode == 0


def _git(args: list[str], *, env: dict[str, str], timeout_s: float, check: bool = True) -> None:
    result = subprocess.run(
        ["git", *args], env=env, capture_output=True, text=True, timeout=timeout_s, check=False
    )
    if check and result.returncode != 0:
        # git puts the remote URL in its errors; the token is not in the URL,
        # but the message is still truncated rather than logged wholesale.
        raise GitHubUnavailable(f"git {args[0]} failed: {result.stderr.strip()[:200]}")


__all__ = [
    "AppCredentials",
    "GitHubUnavailable",
    "clone_repository",
    "create_pull_request",
    "installation_token",
    "mint_app_jwt",
    "push_branch",
]
