"""Internal event bus for the workflow engine.

Existing services call :func:`publish_event` after committing their change;
it matches enabled workflows of the org whose ``trigger.event`` nodes listen
to the event type (plus an optional key/value payload filter) and creates
pending ``WorkflowRun`` rows in the *same* transaction, so an event and the
change that caused it commit or roll back together. The scheduler's worker
poll picks pending runs up within seconds.

publish_event never raises — a workflow-engine failure must never break the
host flow (print accounting, orders, …).
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.workflow import Workflow
from app.services.workflow_engine import create_run
from app.services.workflow_nodes import TRIGGER_TYPES

log = logging.getLogger(__name__)

# Event type constants — mirrors workflow_nodes.EVENT_TYPES catalog.
PRINT_COMPLETED = "print.completed"
PRINT_FAILED = "print.failed"
PRINT_CANCELLED = "print.cancelled"
PRINTER_STATE_CHANGED = "printer.state_changed"
ORDER_CREATED = "order.created"
ORDER_SHIPPED = "order.shipped"
FILAMENT_LOW = "filament.low"
WEBHOOK_RECEIVED = "webhook.received"

PRINT_RESULT_EVENTS = {
    "completed": PRINT_COMPLETED,
    "failed": PRINT_FAILED,
    "cancelled": PRINT_CANCELLED,
}


def print_event_payload(history, printer_name: str) -> dict[str, Any]:
    """Common payload for print.* events from PrintHistory rows."""
    return {
        "history_id": history.id,
        "printer_id": history.printer_id,
        "printer_name": printer_name,
        "file_name": history.file_name,
        "result": history.result,
        "duration_minutes": history.duration_minutes,
        "filament_g": history.filament_g,
        "source": history.source,
    }


def filament_low_payload(filament) -> dict[str, Any]:
    return {
        "filament_id": filament.id,
        "name": " ".join(p for p in (filament.brand, filament.material, filament.color) if p),
        "material": filament.material,
        "color": filament.color,
        "grams_remaining": filament.grams_remaining,
        "min_grams": filament.min_grams,
    }


def order_event_payload(order, *, items_count: int | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "order_id": order.id,
        "number": order.order_number,
        "source": order.source.value if hasattr(order.source, "value") else str(order.source),
        "status": order.status.value if hasattr(order.status, "value") else str(order.status),
        "total": float(order.total_amount or 0),
        "counterparty": order.customer_name,
    }
    if items_count is not None:
        payload["items_count"] = items_count
    return payload


def _node_matches(node: dict[str, Any], event_type: str, payload: dict[str, Any]) -> bool:
    if node.get("type") != "trigger.event":
        return False
    config = node.get("config") or {}
    if config.get("event_type") != event_type:
        return False
    flt = config.get("filter") or {}
    if not isinstance(flt, dict):
        return True
    return all(payload.get(str(k)) == v for k, v in flt.items() if v is not None)


def publish_event(db: Session, org_id: int, event_type: str, payload: dict[str, Any] | None) -> int:
    """Create pending runs for every matching workflow. Returns the run count."""
    try:
        with db.begin_nested():
            payload = payload or {}
            workflows = (
                db.query(Workflow)
                .filter(Workflow.organization_id == org_id, Workflow.enabled.is_(True))
                .all()
            )
            created = 0
            for workflow in workflows:
                matched = [
                    node
                    for node in (workflow.graph or {}).get("nodes", [])
                    if node.get("type") in TRIGGER_TYPES and _node_matches(node, event_type, payload)
                ]
                if not matched:
                    continue
                for node in matched:
                    create_run(db, workflow, event_type, payload, fired_node_key=node.get("key"))
                    created += 1
            if created:
                log.info("workflow event %s: %d run(s) queued for org %s", event_type, created, org_id)
            return created
    except Exception:  # noqa: BLE001 — the host flow must never break because of us
        log.exception("publish_event(%s) failed for org %s", event_type, org_id)
        return 0
