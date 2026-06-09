"""Filament consumption accounting after a print finishes.

Called by print_tracker on state transition printing → complete/cancelled/error
for any printer kind. Mirrors the lifecycle from print_history_bambu.py.

Idempotency: one print = one set of FilamentLog deductions = one PrintHistory
update. Deductions are tagged with reason="print_history:{history.id}:slot{N}";
presence of that tag is the guard against double-write on reconnect / repeated
polling cycles.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.filament import Filament, FilamentLog
from app.models.print_history import PrintHistory
from app.models.printer import Printer
from app.models.printer_slot import PrinterSlot

log = logging.getLogger(__name__)


def finalize_print(
    db: Session,
    history: PrintHistory,
    printer: Printer,
    result: str,
    now: datetime | None = None,
) -> None:
    """Close an in-progress history entry with consumption accounting.

    Works for any printer kind — consumption is resolved via the printer driver.
    Does nothing if the entry is already finalized.
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

    # Consumption via kind-aware driver
    from app.services.printer_driver import get_driver
    slot_grams = get_driver(printer.kind).get_slot_consumption(
        printer, history.file_name, history.filament_g, db=db
    )
    if not slot_grams:
        return

    slots_used = []
    total_cost = Decimal("0")

    for slot_index, grams in slot_grams.items():
        slot = db.query(PrinterSlot).filter_by(
            printer_id=printer.id, slot_index=slot_index
        ).first()
        if slot is None or slot.filament_id is None:
            slots_used.append({"slot_index": slot_index, "grams": round(grams, 1)})
            continue

        filament = db.get(Filament, slot.filament_id)
        if filament is None:
            slots_used.append({"slot_index": slot_index, "grams": round(grams, 1)})
            continue

        # Idempotency guard — tag format must not change without a data migration
        reason_key = f"print_history:{history.id}:slot{slot_index}"
        existing = db.query(FilamentLog).filter(
            FilamentLog.filament_id == filament.id,
            FilamentLog.reason == reason_key,
        ).first()
        if existing:
            log.debug(
                "print_costing: skip double-deduction filament=%s slot=%s history=%s",
                filament.id, slot_index, history.id,
            )
        else:
            deduct = max(0, int(round(grams)))
            new_remaining = max(0, filament.grams_remaining - deduct)
            filament.grams_remaining = new_remaining
            db.add(FilamentLog(
                organization_id=filament.organization_id,
                filament_id=filament.id,
                delta_grams=-deduct,
                grams_after=new_remaining,
                reason=reason_key,
            ))

        cost_per_kg = filament.cost_per_kg or 0
        slot_cost = Decimal(str(round(grams, 3))) / Decimal("1000") * Decimal(str(cost_per_kg))
        total_cost += slot_cost

        slots_used.append({
            "slot_index": slot_index,
            "filament_id": filament.id,
            "grams": round(grams, 1),
            "material": filament.material,
            "color": filament.color,
            "hex_color": filament.hex_color,
        })

    history.slots_used = slots_used if slots_used else None
    history.material_cost = total_cost if total_cost > 0 else None
    history.filament_g = sum(s["grams"] for s in slots_used) if slots_used else history.filament_g

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
