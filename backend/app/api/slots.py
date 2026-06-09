"""Printer filament slot endpoints.

Source of truth for which physical spool is in each U1 toolhead.
Slot indices are 0-based (matching G-code T0..T3 and loaded_filaments JSONB).
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.filament import Filament
from app.models.organization import Organization
from app.models.printer import Printer
from app.models.printer_slot import PrinterSlot, SlotEvent, SlotEventType, SlotState
from app.models.user import User, UserRole
from app.schemas.printer_slot import PrinterSlotOut, SlotAssign, SlotEventOut

router = APIRouter(prefix="/printers", tags=["slots"])


def _get_printer(db: Session, printer_id: int, org_id: int) -> Printer:
    p = db.query(Printer).filter_by(id=printer_id, organization_id=org_id).first()
    if not p:
        raise HTTPException(404, detail="Принтер не знайдено")
    return p


def _get_or_create_slot(db: Session, printer_id: int, slot_index: int) -> PrinterSlot:
    slot = db.query(PrinterSlot).filter_by(
        printer_id=printer_id, slot_index=slot_index
    ).first()
    if not slot:
        slot = PrinterSlot(printer_id=printer_id, slot_index=slot_index, state=SlotState.empty)
        db.add(slot)
        db.flush()
    return slot


def _snapshot_from_filament(slot: PrinterSlot, filament: Filament) -> None:
    slot.material = filament.material
    slot.color = filament.color
    slot.hex_color = filament.hex_color
    slot.brand = filament.brand
    slot.grams_at_load = filament.grams_remaining


@router.get("/{printer_id}/slots", response_model=list[PrinterSlotOut])
def list_slots(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrinterSlot]:
    _get_printer(db, printer_id, org.id)
    slots = (
        db.query(PrinterSlot)
        .filter_by(printer_id=printer_id)
        .order_by(PrinterSlot.slot_index)
        .all()
    )
    # Ensure 4 slots always returned for U1 (0-3)
    by_index = {s.slot_index: s for s in slots}
    result = []
    for i in range(4):
        if i not in by_index:
            s = _get_or_create_slot(db, printer_id, i)
            by_index[i] = s
            db.commit()
            db.refresh(s)
        result.append(by_index[i])
    return result


@router.put("/{printer_id}/slots/{slot_index}", response_model=PrinterSlotOut)
def assign_slot(
    printer_id: int,
    slot_index: int,
    payload: SlotAssign,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterSlot:
    """Assign a filament spool to a slot, or clear with filament_id=null."""
    _get_printer(db, printer_id, org.id)
    if slot_index < 0 or slot_index > 3:
        raise HTTPException(400, detail="slot_index має бути 0-3")

    slot = _get_or_create_slot(db, printer_id, slot_index)
    now = datetime.now(timezone.utc)

    if payload.filament_id is not None:
        filament = db.query(Filament).filter_by(
            id=payload.filament_id, organization_id=org.id
        ).first()
        if not filament:
            raise HTTPException(404, detail="Філамент не знайдено")

        slot.filament_id = filament.id
        _snapshot_from_filament(slot, filament)
        slot.state = SlotState.loaded
        slot.updated_at = now

        db.add(SlotEvent(
            printer_id=printer_id,
            slot_index=slot_index,
            event=SlotEventType.load,
            filament_id=filament.id,
            user_id=user.id,
        ))
    else:
        # Unload
        old_filament_id = slot.filament_id
        slot.filament_id = None
        slot.material = None
        slot.color = None
        slot.hex_color = None
        slot.brand = None
        slot.grams_at_load = None
        slot.state = SlotState.empty
        slot.updated_at = now

        db.add(SlotEvent(
            printer_id=printer_id,
            slot_index=slot_index,
            event=SlotEventType.unload,
            filament_id=old_filament_id,
            user_id=user.id,
        ))

    db.commit()
    db.refresh(slot)
    return slot


@router.post("/{printer_id}/slots/{slot_index}/unload", response_model=PrinterSlotOut)
def unload_slot(
    printer_id: int,
    slot_index: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterSlot:
    return assign_slot(
        printer_id, slot_index, SlotAssign(filament_id=None),
        db=db, org=org, user=user,
    )


@router.get("/{printer_id}/slots/{slot_index}/events", response_model=list[SlotEventOut])
def list_slot_events(
    printer_id: int,
    slot_index: int,
    limit: int = 50,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[SlotEvent]:
    _get_printer(db, printer_id, org.id)
    return (
        db.query(SlotEvent)
        .filter_by(printer_id=printer_id, slot_index=slot_index)
        .order_by(SlotEvent.created_at.desc())
        .limit(limit)
        .all()
    )
