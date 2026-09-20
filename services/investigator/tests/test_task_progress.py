"""The investigation record must show progress while the task is still running.

The record is what the API serves and the UI reads. When phase changes stayed
inside the task process, a healthy investigation looked stuck at PREPARING for
the whole run, then jumped straight to its final state.
"""

from __future__ import annotations

from typing import Any


class RecordingStore:
    """Captures what the task would write, in order."""

    def __init__(self) -> None:
        self.statuses: list[str] = []
        self.event_batches: list[list[dict[str, Any]]] = []

    def set_status(self, _investigation_id: str, status: str, **_kw: Any) -> None:
        self.statuses.append(status)

    def put_events(self, _investigation_id: str, events: list[dict[str, Any]]) -> None:
        self.event_batches.append(list(events))


def build_sink(store: RecordingStore) -> tuple[Any, list[dict[str, Any]]]:
    """The real sink the ECS task uses — imported, not reimplemented."""
    from netra_investigator.aws.task import make_progress_sink

    collected: list[dict[str, Any]] = []
    return make_progress_sink(store, "inv_1", collected), collected


class TestProgressReachesTheRecord:
    def test_every_phase_is_written_as_it_happens(self) -> None:
        store = RecordingStore()
        sink, _ = build_sink(store)

        for status in ("PREPARING", "INVESTIGATING", "EVIDENCE_COLLECTION", "VERIFYING"):
            sink({"type": "status_changed", "status": status})

        # Not one batched write at the end: each phase lands when it happens.
        assert store.statuses == [
            "PREPARING",
            "INVESTIGATING",
            "EVIDENCE_COLLECTION",
            "VERIFYING",
        ]

    def test_terminal_states_are_left_to_the_final_write(self) -> None:
        store = RecordingStore()
        sink, _ = build_sink(store)

        sink({"type": "status_changed", "status": "INVESTIGATING"})
        for status in ("AWAITING_APPROVAL", "RESOLVED", "FAILED", "REJECTED"):
            sink({"type": "status_changed", "status": status})

        # A terminal status carries severity, counts and a summary that only the
        # final write has. Announcing it early would publish it without them.
        assert store.statuses == ["INVESTIGATING"]

    def test_a_phase_change_flushes_the_events_behind_it(self) -> None:
        store = RecordingStore()
        sink, _ = build_sink(store)

        for i in range(3):
            sink({"type": "command_output", "seq": i})
        assert store.event_batches == []  # still batching

        sink({"type": "status_changed", "status": "INVESTIGATING"})

        # The three outputs plus the status change reach the table together, so
        # a reader that sees the new phase can also see what produced it.
        assert len(store.event_batches) == 1
        assert len(store.event_batches[0]) == 4

    def test_no_event_is_written_twice(self) -> None:
        store = RecordingStore()
        sink, collected = build_sink(store)

        for i in range(25):
            sink({"type": "command_output", "seq": i})
        sink({"type": "status_changed", "status": "VERIFYING"})

        written = [e for batch in store.event_batches for e in batch]
        assert len(written) == len(collected)
        assert [e.get("seq") for e in written] == [e.get("seq") for e in collected]

    def test_a_failing_status_write_does_not_stop_the_investigation(self) -> None:
        class BrokenStore(RecordingStore):
            def set_status(self, *_a: Any, **_kw: Any) -> None:
                raise RuntimeError("throttled")

        store = BrokenStore()
        sink, collected = build_sink(store)

        # Progress reporting is not worth failing a run over: a throttled write
        # is logged and the investigation carries on.
        sink({"type": "status_changed", "status": "INVESTIGATING"})
        sink({"type": "command_output", "seq": 1})

        assert len(collected) == 2
        assert store.event_batches  # events still reached the table
