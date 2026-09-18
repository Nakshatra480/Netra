"""Persisting an investigation to DynamoDB.

One table, keyed so that everything belonging to one investigation is a single
query: the investigation record, its lifecycle events, findings, evidence,
verification results and blast radius.

    pk = INV#<investigationId>
    sk = META | EVENT#<seq> | FINDING#<id> | EVIDENCE#<id> | VERIFY#<id> | GRAPH

Model chain-of-thought is never written here. What is stored is what a reviewer
needs: concise findings, evidence with provenance, tool results, verification
verdicts and the conclusion.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

logger = logging.getLogger(__name__)


def _boto3():
    """Imported lazily so local runs need no AWS SDK installed."""
    import boto3

    return boto3


class InvestigationStore:
    """Writes investigation state and results."""

    def __init__(self, table_name: str, region: str = "eu-north-1") -> None:
        self._table = _boto3().resource("dynamodb", region_name=region).Table(table_name)
        self._table_name = table_name

    # -- lifecycle ---------------------------------------------------------

    def create(self, investigation: dict[str, Any]) -> bool:
        """Create the investigation record, or report that it already exists.

        A conditional write, so a replayed event cannot start a second
        investigation for the same delivery.
        """
        from botocore.exceptions import ClientError

        item = {
            "pk": _pk(investigation["id"]),
            "sk": "META",
            **_clean(investigation),
        }
        try:
            self._table.put_item(
                Item=item, ConditionExpression="attribute_not_exists(pk)"
            )
            return True
        except ClientError as err:
            if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise

    def set_status(
        self,
        investigation_id: str,
        status: str,
        *,
        failure_reason: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        names = {"#s": "status"}
        values: dict[str, Any] = {":s": status}
        sets = ["#s = :s"]

        if failure_reason is not None:
            names["#fr"] = "failureReason"
            values[":fr"] = failure_reason[:1000]
            sets.append("#fr = :fr")

        for index, (key, value) in enumerate((extra or {}).items()):
            names[f"#e{index}"] = key
            values[f":e{index}"] = _clean(value)
            sets.append(f"#e{index} = :e{index}")

        self._table.update_item(
            Key={"pk": _pk(investigation_id), "sk": "META"},
            UpdateExpression="SET " + ", ".join(sets),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )

    # -- results -----------------------------------------------------------

    def put_events(self, investigation_id: str, events: list[dict[str, Any]]) -> None:
        """Append lifecycle and terminal events.

        Command output is already bounded by the sandbox; it is stored as-is so
        the UI can replay exactly what the investigation showed.
        """
        self._batch(investigation_id, [(f"EVENT#{e['seq']:06d}", e) for e in events])

    def put_findings(self, investigation_id: str, findings: list[dict[str, Any]]) -> None:
        self._batch(investigation_id, [(f"FINDING#{f['id']}", f) for f in findings])

    def put_evidence(self, investigation_id: str, evidence: list[dict[str, Any]]) -> None:
        self._batch(investigation_id, [(f"EVIDENCE#{e['id']}", e) for e in evidence])

    def put_verifications(self, investigation_id: str, results: list[dict[str, Any]]) -> None:
        self._batch(investigation_id, [(f"VERIFY#{v['id']}", v) for v in results])

    def put_graph(self, investigation_id: str, graph: dict[str, Any]) -> None:
        self._batch(investigation_id, [("GRAPH", graph)])

    def put_remediation(self, investigation_id: str, remediation: dict[str, Any]) -> None:
        self._batch(investigation_id, [("REMEDIATION", remediation)])

    def put_action(self, investigation_id: str, action: dict[str, Any]) -> None:
        self._batch(investigation_id, [("ACTION", action)])

    def _batch(self, investigation_id: str, rows: list[tuple[str, dict[str, Any]]]) -> None:
        if not rows:
            return
        with self._table.batch_writer() as batch:
            for sort_key, payload in rows:
                batch.put_item(
                    Item={"pk": _pk(investigation_id), "sk": sort_key, **_clean(payload)}
                )

    def get(self, investigation_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"pk": _pk(investigation_id), "sk": "META"})
        return response.get("Item")


def _pk(investigation_id: str) -> str:
    return f"INV#{investigation_id}"


def _clean(value: Any) -> Any:
    """Make a payload safe for DynamoDB.

    Floats become Decimal, and empty strings become None: DynamoDB rejects the
    former outright and treats the latter inconsistently across SDK versions.
    """
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if value == "":
        return None
    return value


__all__ = ["InvestigationStore"]
