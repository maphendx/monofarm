from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_roles
from app.core.db import get_db
from app.models.plan import PlanEntry
from app.models.printer import Printer
from app.models.task import PrintTask
from app.models.user import User, UserRole
from app.schemas.plan import PlanEntryCreate, PlanEntryOut, PlanEntryUpdate


router = APIRouter(prefix="/plan", tags=["plan"])


def _to_out(entry: PlanEntry, db: Session) -> PlanEntryOut:
    printer = db.get(Printer, entry.printer_id)
    task = db.get(PrintTask, entry.task_id)
    return PlanEntryOut(
        id=entry.id,
        plan_date=entry.plan_date,
        printer_id=entry.printer_id,
        printer_name=printer.name if printer else str(entry.printer_id),
        task_id=entry.task_id,
        task=task,
        sequence=entry.sequence,
        note=entry.note,
        done=entry.done,
        created_at=entry.created_at,
    )


@router.get("", response_model=list[PlanEntryOut])
def get_plan(
    plan_date: date | None = None,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[PlanEntryOut]:
    target = plan_date or date.today()
    entries = (
        db.query(PlanEntry)
        .filter(PlanEntry.plan_date == target)
        .order_by(PlanEntry.printer_id, PlanEntry.sequence, PlanEntry.created_at)
        .all()
    )
    return [_to_out(e, db) for e in entries]


@router.post("", response_model=PlanEntryOut, status_code=status.HTTP_201_CREATED)
def create_entry(
    payload: PlanEntryCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PlanEntryOut:
    if not db.get(Printer, payload.printer_id):
        raise HTTPException(status_code=404, detail="Printer not found")
    if not db.get(PrintTask, payload.task_id):
        raise HTTPException(status_code=404, detail="Task not found")

    # Sequence = next available for that printer+date
    existing = (
        db.query(PlanEntry)
        .filter(
            PlanEntry.plan_date == payload.plan_date,
            PlanEntry.printer_id == payload.printer_id,
        )
        .count()
    )
    entry = PlanEntry(
        plan_date=payload.plan_date,
        printer_id=payload.printer_id,
        task_id=payload.task_id,
        sequence=existing,
        note=payload.note,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return _to_out(entry, db)


@router.patch("/{entry_id}", response_model=PlanEntryOut)
def update_entry(
    entry_id: int,
    payload: PlanEntryUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PlanEntryOut:
    entry = db.get(PlanEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Plan entry not found")
    if payload.done is not None:
        entry.done = payload.done
    if payload.note is not None:
        entry.note = payload.note
    db.commit()
    db.refresh(entry)
    return _to_out(entry, db)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    entry = db.get(PlanEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Plan entry not found")
    db.delete(entry)
    db.commit()
