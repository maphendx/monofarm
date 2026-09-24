"""Material reservations — future demand on a spool from dispatched jobs.

Lifecycle: job dispatched → reservation created (transaction-safe against
concurrent dispatches) → print finalized → actual consumption becomes the
accounting truth and the reservation is consumed; job cancelled/failed before
accounting → reservation released. Repeat calls are no-ops (deterministic
references + partial unique index).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from app.models.filament_reservation import FilamentReservation

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

log = logging.getLogger(__name__)


def job_reference(job_id: int, slot_index: int) -> str:
    return f"job:{job_id}:slot{slot_index}"


def reserve_for_job(
    db: "Session", org_id: int, job_id: int, grams_by_slot: dict[int, float],
    *, filament_by_slot: dict[int, int],
) -> int:
    """Reserve planned grams per spool for a dispatched job.

    The caller must have locked the involved spool rows (``FOR UPDATE``) in a
    stable order so concurrent dispatches serialize. Idempotent per
    (spool, reference); an over-reservation attempt logs and skips — the
    pre-flight check is the gate, the reservation is bookkeeping.
    """
    from app.models.filament import Filament

    created = 0
    for slot_index, grams in sorted(grams_by_slot.items()):
        filament_id = filament_by_slot.get(slot_index)
        grams = int(round(max(0.0, float(grams))))
        if filament_id is None or grams <= 0:
            continue
        reference = job_reference(job_id, slot_index)
        existing = db.query(FilamentReservation).filter(
            FilamentReservation.filament_id == filament_id,
            FilamentReservation.reference == reference,
        ).first()
        if existing:
            continue
        filament = db.get(Filament, filament_id)
        if filament is None or filament.organization_id != org_id:
            continue
        reserved_now = sum(
            r.reserved_g for r in db.query(FilamentReservation).filter(
                FilamentReservation.filament_id == filament_id,
                FilamentReservation.status == "active",
            ).all()
        )
        if reserved_now + grams > filament.grams_remaining:
            log.warning(
                "filament_reservations: spool=%s over-reservation refused "
                "(remaining=%s active=%s wanted=%s job=%s)",
                filament_id, filament.grams_remaining, reserved_now, grams, job_id,
            )
            continue
        db.add(FilamentReservation(
            organization_id=org_id, filament_id=filament_id,
            job_id=job_id, reference=reference, reserved_g=grams,
        ))
        created += 1
    if created:
        db.flush()
        log.info("filament_reservations: %d reservation(s) for job=%s", created, job_id)
    return created


def _settle_for_job(db: "Session", job_id: int, status: str) -> int:
    rows = db.query(FilamentReservation).filter(
        FilamentReservation.job_id == job_id,
        FilamentReservation.status == "active",
    ).all()
    now = datetime.now(timezone.utc)
    for row in rows:
        row.status = status
        row.released_at = now
    if rows:
        db.flush()
        log.info("filament_reservations: %d -> %s for job=%s", len(rows), status, job_id)
    return len(rows)


def consume_for_job(db: "Session", job_id: int) -> int:
    """Actual consumption was recorded — the reservation becomes accounting truth."""
    return _settle_for_job(db, job_id, "consumed")


def release_for_job(db: "Session", job_id: int) -> int:
    """Job cancelled/failed before accounting — free the promised grams."""
    return _settle_for_job(db, job_id, "released")
