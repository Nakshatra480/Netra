"""Construction of the blast-radius graph.

The graph is a rendering of what the analyzer proved, not an illustration. Every
node and edge comes from a traced import path, a diff entry, or the bundler
configuration, and carries the evidence ids that justify it. A node is marked
`onAffectedPath` only when it lies on a route from the change to the finding.
"""

from __future__ import annotations

from typing import Any

from .secret_flow import SecretFlowReport

#: Repository conventions used only to label nodes, never to draw conclusions.
_SERVICE_HINTS = ("s3", "amazonaws", "bucket")


def _node(
    node_id: str,
    kind: str,
    label: str,
    *,
    file: str | None = None,
    line: int | None = None,
    affected: bool = False,
    evidence_ids: list[str] | None = None,
    verification: str = "VERIFIED",
) -> dict[str, Any]:
    return {
        "id": node_id,
        "kind": kind,
        "label": label,
        "file": file,
        "line": line,
        "onAffectedPath": affected,
        "evidenceIds": evidence_ids or [],
        "verificationStatus": verification,
    }


def build_graph(
    report: SecretFlowReport,
    finding: dict[str, Any] | None,
    evidence: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the graph for an investigation, whether or not it found anything."""
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}

    evidence_by_file: dict[str, list[str]] = {}
    for item in evidence:
        evidence_by_file.setdefault(item["file"], []).append(item["id"])

    changed = set(report.changed_files)
    affected_files = {p.reference.file for p in report.exposure_paths}
    for path in report.exposure_paths:
        affected_files.update(path.hops)

    def file_node(path: str) -> str:
        node_id = f"file:{path}"
        if node_id not in nodes:
            nodes[node_id] = _node(
                node_id,
                "CHANGED_FILE" if path in changed else "FILE",
                path.rsplit("/", 1)[-1],
                file=path,
                affected=path in affected_files,
                evidence_ids=evidence_by_file.get(path, []),
            )
        return node_id

    def add_edge(source: str, target: str, relationship: str, affected: bool) -> None:
        edge_id = f"{source}->{target}:{relationship}"
        if edge_id not in edges:
            edges[edge_id] = {
                "id": edge_id,
                "source": source,
                "target": target,
                "relationship": relationship,
                "onAffectedPath": affected,
                "evidenceIds": [],
            }

    # Every file the change touched is on the graph, even when it is not on an
    # exposure path: the reviewer asked "what did this change affect?".
    for path in report.changed_files:
        file_node(path)

    # Import edges along each traced exposure path.
    for path in report.exposure_paths:
        for importer, imported in zip(path.hops, path.hops[1:], strict=False):
            add_edge(file_node(importer), file_node(imported), "imports", True)

        secret_id = f"secret:{path.secret}"
        if secret_id not in nodes:
            nodes[secret_id] = _node(
                secret_id,
                "SECRET",
                path.secret,
                affected=True,
                evidence_ids=evidence_by_file.get(path.reference.file, []),
            )
        add_edge(file_node(path.reference.file), secret_id, "reads", True)

    # The bundler is what turns a read into a publication.
    if report.inlined_by_bundler and report.surface and report.surface.config_file:
        config_id = file_node(report.surface.config_file)
        nodes[config_id]["onAffectedPath"] = True
        bundle_id = "artifact:browser-bundle"
        nodes[bundle_id] = _node(
            bundle_id,
            "EXTERNAL_SERVICE",
            "Public browser bundle",
            affected=True,
            evidence_ids=[],
        )
        for secret in report.inlined_by_bundler:
            secret_id = f"secret:{secret}"
            if secret_id not in nodes:
                nodes[secret_id] = _node(secret_id, "SECRET", secret, affected=True)
            add_edge(config_id, secret_id, "inlines", True)
            add_edge(secret_id, bundle_id, "published in", True)
        for entry in report.surface.entries:
            add_edge(file_node(entry), bundle_id, "bundled into", True)

    # The finding terminates the graph: this is what the path adds up to.
    if finding is not None:
        finding_id = f"finding:{finding['id']}"
        nodes[finding_id] = _node(
            finding_id,
            "FINDING",
            finding["title"],
            affected=True,
            evidence_ids=[e["id"] for e in evidence],
        )
        for secret in report.exposed_secrets:
            secret_node = f"secret:{secret}"
            if secret_node in nodes:
                add_edge(secret_node, finding_id, "supports", True)

    node_list = list(nodes.values())
    edge_list = [e for e in edges.values() if e["source"] in nodes and e["target"] in nodes]
    return {
        "nodes": node_list,
        "edges": edge_list,
        "summary": _summarize(report, finding, node_list, edge_list),
    }


def _summarize(
    report: SecretFlowReport,
    finding: dict[str, Any] | None,
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> str:
    """Text alternative to the graph, for screen readers and for the API."""
    if finding is None:
        return (
            f"{len(report.changed_files)} changed file(s) were analysed. "
            "No credential was found to reach a published context."
        )
    affected = [n for n in nodes if n["onAffectedPath"]]
    lines = [
        f"{len(nodes)} artifacts, {len(edges)} relationships, "
        f"{len(affected)} on the affected path.",
    ]
    for path in report.exposure_paths[:3]:
        lines.append(f"{' -> '.join(path.hops)} reads {path.secret}.")
    if report.inlined_by_bundler and report.surface and report.surface.config_file:
        lines.append(
            f"{report.surface.config_file} inlines "
            f"{', '.join(report.inlined_by_bundler)} into the public browser bundle."
        )
    return " ".join(lines)


__all__ = ["build_graph"]
