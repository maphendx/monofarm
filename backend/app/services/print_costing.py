"""Filament consumption accounting after a print finishes.

Called by print_tracker on state transition printing → complete/cancelled/error
for any printer kind, and by the Bambu cloud-job history sync. Mirrors the
lifecycle from print_history_bambu.py.

The heavy lifting lives in ``print_accounting``: consumption resolution
(telemetry → plan → progress hierarchy), spool deduction, warehouse material
WRITE_OFF and material cost — one idempotent pipeline per physical run.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.print_history import PrintHistory
from app.models.printer import Printer
from app.services import print_accounting, workflow_events

log = logging.getLogger(__name__)


def finalize_print(
    db: Session,
    history: PrintHistory,
    printer: Printer,
    result: str,
    now: datetime | None = None,
) -> None:
    """Close an in-progress history entry with consumption accounting.

    Works for any printer kind. Does nothing if the entry is already finalized
    or its consumption was already recorded (tracker retry, cloud sync, replay).
    """
    if history.result != "in_progress":
        return

    now = now or datetime.now(timezone.utc)
    history.result = result
    history.finished_at = now
    history.printer_kind = printer.kind.value

    delta = now - (
        history.started_at.replace(tzinfo=timezone.utc)
        if history.started_at.tzinfo is None
        else history.started_at
    )
    history.duration_minutes = max(0, int(delta.total_seconds() / 60))

    from app.services.telegram_notify import notify_failed_history
    notify_failed_history(db, history)

    if not print_accounting.run_already_deducted(db, history.id):
        consumption = print_accounting.resolve_consumption(db, history, printer, result)
        applied = print_accounting.apply_consumption(db, history, printer, consumption)
    else:
        applied = print_accounting.AppliedConsumption()
        log.info("print_accounting: history=%s already deducted — skipping", history.id)

    if history.bambu_cloud_job_id is not None:
        # Actual consumption recorded — the reservation's job is done.
        from app.services import filament_reservations
        try:
            filament_reservations.consume_for_job(db, history.bambu_cloud_job_id)
        except Exception:  # noqa: BLE001 — bookkeeping must not break accounting
            log.exception("reservation consume failed for job=%s", history.bambu_cloud_job_id)

    for filament, prev_remaining in applied.low_filaments:
        workflow_events.publish_event(
            db, filament.organization_id, workflow_events.FILAMENT_LOW,
            workflow_events.filament_low_payload(filament),
        )
        # Ready-made Telegram rule (no workflow engine involved).
        from app.services.telegram_notify import notify_filament_low_if_crossed
        notify_filament_low_if_crossed(db, filament.organization_id, filament, prev_grams=prev_remaining)

    db.flush()

    log.info(
        "print_costing: finalized printer=%s kind=%s file=%s result=%s grams=%.1f cost=%s",
        printer.id,
        printer.kind.value,
        history.file_name,
        result,
        history.filament_g or 0,
        history.material_cost,
    )
