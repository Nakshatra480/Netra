"""Deterministic credential-exposure analysis.

This analyzer answers one question with code rather than inference:

    Does this change cause a secret to reach a context that publishes it?

It is deliberately conservative. It reports a finding only when it can trace a
concrete path from a secret-named identifier introduced by the diff to a file
that is reachable from a browser bundle entry point, or when a bundler is
configured to inline the secret's value. Every step of that path is recorded as
evidence with a file, a line, and the command that produced it.

A language model may propose that such a flow exists. Only this module may mark
it VERIFIED.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field

from ..tools import InvestigationTools, Match, is_within

VERIFIER_ID = "secret-flow-v1"

#: Identifier names that denote a credential. Matching is on the whole
#: identifier, so `AWS_REGION` and `PUBLIC_KEY_ID` are not secrets.
_SECRET_NAME = re.compile(
    r"^(?:[A-Z0-9]+_)*(?:SECRET(?:_[A-Z0-9]+)*|"
    r"(?:SECRET_)?ACCESS_KEY(?:_ID)?|PRIVATE_KEY|API_KEY|AUTH_TOKEN|"
    r"PASSWORD|CLIENT_SECRET|SESSION_SECRET|SIGNING_KEY)$"
)

#: Identifiers that look sensitive but are safe to publish.
_SECRET_ALLOWLIST = frozenset({"AWS_ACCESS_KEY_ID_PUBLIC", "PUBLIC_API_KEY"})

#: Environment-variable reads in JavaScript/TypeScript source.
_ENV_READ = re.compile(r"(?:process\.env|import\.meta\.env)\s*(?:\.\s*|\[\s*['\"])([A-Z0-9_]+)")

#: Relative module imports and requires.
_IMPORT = re.compile(
    r"""(?:import\s[^'"]*from\s*|import\s*|require\s*\(\s*)['"](\.{1,2}/[^'"]+)['"]""",
    re.VERBOSE,
)

#: A bundler `define` entry that substitutes an environment value at build time.
_VITE_DEFINE_KEY = re.compile(r"['\"](?:process\.env|import\.meta\.env)\.([A-Z0-9_]+)['\"]\s*:")
_VITE_ROOT = re.compile(r"\broot\s*:\s*['\"]([^'\"]+)['\"]")

_SOURCE_SUFFIXES = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")


def is_secret_name(name: str) -> bool:
    """Whether an identifier names a credential."""
    return name not in _SECRET_ALLOWLIST and bool(_SECRET_NAME.match(name))


@dataclass(frozen=True, slots=True)
class SecretReference:
    """A place where a secret-named identifier is read."""

    secret: str
    file: str
    line: int
    text: str


@dataclass(frozen=True, slots=True)
class ClientSurface:
    """The part of the repository that is compiled into the browser bundle."""

    #: Directory the bundler treats as the client root, e.g. "src/client".
    root: str
    #: Entry modules reachable by the browser.
    entries: tuple[str, ...]
    #: The bundler configuration file this was derived from.
    config_file: str | None
    #: Secrets the bundler is configured to inline into the bundle.
    inlined_secrets: tuple[str, ...]


@dataclass(slots=True)
class ExposurePath:
    """A proven route from a browser entry point to a secret read."""

    secret: str
    #: Module path, from the client entry through imports to the reading file.
    hops: list[str]
    reference: SecretReference

    @property
    def reaches_client(self) -> bool:
        return len(self.hops) > 0


@dataclass(slots=True)
class SecretFlowReport:
    """The analyzer's complete, deterministic result."""

    secrets_introduced: list[SecretReference] = field(default_factory=list)
    surface: ClientSurface | None = None
    exposure_paths: list[ExposurePath] = field(default_factory=list)
    inlined_by_bundler: list[str] = field(default_factory=list)
    #: Module graph actually used for reachability: importer -> imported files.
    module_graph: dict[str, list[str]] = field(default_factory=dict)
    changed_files: list[str] = field(default_factory=list)

    @property
    def exposed(self) -> bool:
        """True only when a concrete exposure was traced, not merely suspected."""
        return bool(self.exposure_paths) or bool(self.inlined_by_bundler)

    @property
    def exposed_secrets(self) -> list[str]:
        names = {p.secret for p in self.exposure_paths} | set(self.inlined_by_bundler)
        return sorted(names)


class SecretFlowAnalyzer:
    """Traces credential flow using only repository facts."""

    def __init__(self, tools: InvestigationTools) -> None:
        self._tools = tools

    def analyze(self) -> SecretFlowReport:
        report = SecretFlowReport()
        changed = self._tools.changed_files()
        report.changed_files = [c.path for c in changed if c.change_type != "DELETED"]

        report.secrets_introduced = self._secrets_introduced_by_diff()
        report.surface = self._client_surface(report.changed_files)

        if report.surface is None:
            return report

        # A bundler that substitutes a secret publishes it regardless of which
        # module reads it, so this is checked independently of reachability.
        report.inlined_by_bundler = [
            s for s in report.surface.inlined_secrets if is_secret_name(s)
        ]

        candidate_secrets = {r.secret for r in report.secrets_introduced}
        candidate_secrets.update(report.inlined_by_bundler)
        if not candidate_secrets:
            return report

        report.module_graph = self._build_module_graph(report.surface)
        client_modules = self._reachable_from_entries(report.surface, report.module_graph)

        for secret in sorted(candidate_secrets):
            for reference in self._references_to(secret):
                if reference.file not in client_modules:
                    continue
                hops = self._path_to(report.surface, report.module_graph, reference.file)
                report.exposure_paths.append(
                    ExposurePath(secret=secret, hops=hops, reference=reference)
                )
        return report

    # -- steps -------------------------------------------------------------

    def _secrets_introduced_by_diff(self) -> list[SecretReference]:
        """Find secret-named identifiers on lines the change *added*.

        Reading the diff rather than the whole tree is what makes this an
        investigation of the change rather than a repository-wide scan.
        """
        diff = self._tools.inspect_diff()
        found: list[SecretReference] = []
        current_file: str | None = None
        new_line_no = 0

        for raw in diff.splitlines():
            if raw.startswith("+++ b/"):
                current_file = raw[6:].strip()
                continue
            if raw.startswith("@@"):
                header = re.search(r"\+(\d+)", raw)
                new_line_no = int(header.group(1)) if header else 0
                continue
            if raw.startswith("+") and not raw.startswith("+++"):
                if current_file:
                    for name in _ENV_READ.findall(raw):
                        if is_secret_name(name):
                            found.append(
                                SecretReference(
                                    secret=name,
                                    file=current_file,
                                    line=new_line_no,
                                    text=raw[1:].strip(),
                                )
                            )
                new_line_no += 1
            elif not raw.startswith("-"):
                new_line_no += 1
        return found

    def _client_surface(self, changed_files: list[str]) -> ClientSurface | None:
        """Derive the browser-facing surface from the bundler configuration.

        The client root is read from the project's own build config rather than
        guessed, so the conclusion holds for this repository specifically.
        """
        configs = [f for f in self._tools.list_files() if f.endswith("vite.config.js")]
        configs += [f for f in self._tools.list_files() if f.endswith("vite.config.ts")]
        if not configs:
            return None

        config_file = configs[0]
        lines = self._tools.read_file(config_file)
        body = "\n".join(lines)

        root_match = _VITE_ROOT.search(body)
        if not root_match:
            return None
        root = root_match.group(1).strip("./")

        inlined = tuple(dict.fromkeys(_VITE_DEFINE_KEY.findall(body)))
        entries = self._entry_modules(root)
        _ = changed_files
        return ClientSurface(
            root=root, entries=entries, config_file=config_file, inlined_secrets=inlined
        )

    def _entry_modules(self, root: str) -> tuple[str, ...]:
        """Modules the browser loads directly, taken from the client HTML."""
        entries: list[str] = []
        for path in self._tools.list_files(root):
            if not path.endswith(".html"):
                continue
            html = "\n".join(self._tools.read_file(path))
            for src in re.findall(r"""<script[^>]+src=['"]([^'"]+)['"]""", html):
                resolved = _resolve(path, src)
                if resolved:
                    entries.append(resolved)
        return tuple(dict.fromkeys(entries))

    def _build_module_graph(self, surface: ClientSurface) -> dict[str, list[str]]:
        """Map each client source file to the modules it imports."""
        graph: dict[str, list[str]] = {}
        for path in self._tools.list_files(surface.root):
            if not path.endswith(_SOURCE_SUFFIXES):
                continue
            source = "\n".join(self._tools.read_file(path))
            imports = []
            for spec in _IMPORT.findall(source):
                resolved = _resolve(path, spec)
                if resolved:
                    imports.append(resolved)
            graph[path] = imports
        return graph

    @staticmethod
    def _reachable_from_entries(
        surface: ClientSurface, graph: dict[str, list[str]]
    ) -> set[str]:
        """Breadth-first closure of the import graph from the browser entries."""
        seen: set[str] = set()
        queue = deque(surface.entries)
        while queue:
            current = queue.popleft()
            if current in seen:
                continue
            seen.add(current)
            queue.extend(graph.get(current, []))
        return seen

    @staticmethod
    def _path_to(
        surface: ClientSurface, graph: dict[str, list[str]], target: str
    ) -> list[str]:
        """Shortest import path from a browser entry to `target`."""
        for entry in surface.entries:
            previous: dict[str, str | None] = {entry: None}
            queue = deque([entry])
            while queue:
                current = queue.popleft()
                if current == target:
                    hops: list[str] = []
                    node: str | None = current
                    while node is not None:
                        hops.append(node)
                        node = previous[node]
                    return list(reversed(hops))
                for neighbour in graph.get(current, []):
                    if neighbour not in previous:
                        previous[neighbour] = current
                        queue.append(neighbour)
        return []

    def _references_to(self, secret: str) -> list[SecretReference]:
        matches: list[Match] = self._tools.find_references(secret)
        return [
            SecretReference(secret=secret, file=m.file, line=m.line, text=m.text)
            for m in matches
        ]


def _resolve(importer: str, spec: str) -> str | None:
    """Resolve a relative import to a repository path.

    Returns None for bare specifiers (package imports), which are not part of
    the repository's own module graph.
    """
    if not spec.startswith("."):
        return None
    parts = importer.split("/")[:-1]
    for segment in spec.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if parts:
                parts.pop()
            continue
        parts.append(segment)
    resolved = "/".join(parts)
    if not resolved.endswith(_SOURCE_SUFFIXES) and not resolved.endswith(".html"):
        resolved = f"{resolved}.js"
    return resolved


__all__ = [
    "ClientSurface",
    "ExposurePath",
    "SecretFlowAnalyzer",
    "SecretFlowReport",
    "SecretReference",
    "VERIFIER_ID",
    "is_secret_name",
    "is_within",
]
