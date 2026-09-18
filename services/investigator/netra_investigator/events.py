"""Emission of investigation events.

Events are the investigation's observable record: every one of them
corresponds to something that actually happened -- a command that ran, output
that was produced, a check that completed. Nothing is emitted for visual
effect, and model reasoning is never emitted; only concise activity summaries
that the pipeline itself decides to publish.

The schema mirrors `@netra/domain`'s `investigationEventSchema`.
"""

from __future__ import annotations

import json
import sys
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, TextIO


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class EventEmitter:
    """Assigns sequence numbers and writes events to a sink.

    A monotonic sequence number lets the UI order and de-duplicate events even
    when they arrive over a reconnecting stream.
    """

    def __init__(self, investigation_id: str, sink: Callable[[dict[str, Any]], None]) -> None:
        self._investigation_id = investigation_id
        self._sink = sink
        self._seq = 0
        self._lock = threading.Lock()

    def emit(self, type_: str, **payload: Any) -> dict[str, Any]:
        with self._lock:
            self._seq += 1
            seq = self._seq
        event = {
            "seq": seq,
            "investigationId": self._investigation_id,
            "at": _now(),
            "type": type_,
            **payload,
        }
        self._sink(event)
        return event

    # -- typed helpers -----------------------------------------------------

    def status_changed(self, status: str, reason: str | None = None) -> None:
        self.emit("status_changed", status=status, reason=reason)

    def activity_started(self, message: str) -> str:
        """Announce work that is starting; returns the id used to complete it."""
        activity_id = new_id("act")
        self.emit("activity", state="STARTED", activityId=activity_id, message=message)
        return activity_id

    def activity_completed(self, activity_id: str, message: str) -> None:
        self.emit("activity", state="COMPLETED", activityId=activity_id, message=message)

    def activity_failed(self, activity_id: str, message: str) -> None:
        self.emit("activity", state="FAILED", activityId=activity_id, message=message)

    def command_started(self, command_id: str, tool: str, command: str) -> None:
        self.emit("command_started", commandId=command_id, tool=tool, command=command)

    def command_output(self, command_id: str, stream: str, chunk: str) -> None:
        self.emit("command_output", commandId=command_id, stream=stream, chunk=chunk)

    def command_finished(
        self, command_id: str, exit_code: int, duration_ms: int, timed_out: bool
    ) -> None:
        self.emit(
            "command_finished",
            commandId=command_id,
            exitCode=exit_code,
            durationMs=duration_ms,
            timedOut=timed_out,
        )

    def finding_detected(self, finding: dict[str, Any]) -> None:
        self.emit("finding_detected", finding=finding)

    def evidence_found(self, evidence: dict[str, Any]) -> None:
        self.emit("evidence_found", evidence=evidence)

    def verification_started(self, verifier: str, finding_id: str) -> None:
        self.emit(
            "verification", state="STARTED", verifier=verifier, findingId=finding_id, result=None
        )

    def verification_completed(
        self, verifier: str, finding_id: str, result: dict[str, Any]
    ) -> None:
        self.emit(
            "verification",
            state="COMPLETED",
            verifier=verifier,
            findingId=finding_id,
            result=result,
        )

    def graph_updated(self, graph: dict[str, Any]) -> None:
        self.emit("graph_updated", graph=graph)

    def remediation_proposed(self, remediation: dict[str, Any], action: dict[str, Any]) -> None:
        self.emit("remediation_proposed", remediation=remediation, action=action)


def ndjson_sink(stream: TextIO | None = None) -> Callable[[dict[str, Any]], None]:
    """Write each event as one JSON line, flushed immediately.

    The API service reads this stream and republishes events to connected
    clients, so flushing per line is what makes the terminal feel live.
    """
    out = stream or sys.stdout

    def sink(event: dict[str, Any]) -> None:
        out.write(json.dumps(event, separators=(",", ":")) + "\n")
        out.flush()

    return sink


def collecting_sink(into: list[dict[str, Any]]) -> Callable[[dict[str, Any]], None]:
    """Collect events in a list. Used by tests and by batch (Lambda) runs."""
    return into.append
