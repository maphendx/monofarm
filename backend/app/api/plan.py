import asyncio
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.plan import PlanEntry
from app.models.printer import Printer, PrinterKind
from app.models.task import PrintTask
from app.models.user import UserRole
from app.schemas.plan import PlanEntryCreate, PlanEntryOut, PlanEntryUpdate
from app.services import moonraker


# Files live under data/uploads/<task_id>/<original_filename>
UPLOADS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "uploads"


class SendResult(BaseModel):
    ok: bool
    message: str


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
    org: Organization = Depends(get_current_org),
) -> list[PlanEntryOut]:
    target = plan_date or date.today()
    entries = (
        db.query(PlanEntry)
        .filter(PlanEntry.plan_date == target, PlanEntry.organization_id == org.id)
        .order_by(PlanEntry.printer_id, PlanEntry.sequence, PlanEntry.created_at)
        .all()
    )
    return [_to_out(e, db) for e in entries]


@router.post("", response_model=PlanEntryOut, status_code=status.HTTP_201_CREATED)
def create_entry(
    payload: PlanEntryCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PlanEntryOut:
    printer = db.query(Printer).filter(Printer.id == payload.printer_id, Printer.organization_id == org.id).first()
    if not printer:
        raise HTTPException(status_code=404, detail="Printer not found")
    task = db.query(PrintTask).filter(PrintTask.id == payload.task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    existing = (
        db.query(PlanEntry)
        .filter(
            PlanEntry.plan_date == payload.plan_date,
            PlanEntry.printer_id == payload.printer_id,
            PlanEntry.organization_id == org.id,
        )
        .count()
    )
    entry = PlanEntry(
        organization_id=org.id,
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
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PlanEntryOut:
    entry = db.query(PlanEntry).filter(PlanEntry.id == entry_id, PlanEntry.organization_id == org.id).first()
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
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    entry = db.query(PlanEntry).filter(PlanEntry.id == entry_id, PlanEntry.organization_id == org.id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Plan entry not found")
    db.delete(entry)
    db.commit()


@router.post("/{entry_id}/send", response_model=SendResult)
async def send_entry_to_printer(
    entry_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> SendResult:
    """Upload the task's file to the printer's Moonraker and start the print."""
    entry = db.query(PlanEntry).filter(PlanEntry.id == entry_id, PlanEntry.organization_id == org.id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Plan entry not found")

    printer = db.get(Printer, entry.printer_id)
    task = db.get(PrintTask, entry.task_id)
    if not printer or not task:
        raise HTTPException(status_code=404, detail="Printer or task not found")
    if not printer.moonraker_url:
        raise HTTPException(status_code=400, detail="У принтера не вказано Moonraker URL")
    if not task.file_ref:
        raise HTTPException(status_code=400, detail="До задачі не прикріплено файл")

    file_path = UPLOADS_DIR / str(task.id) / task.file_ref
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Файл відсутній на диску")

    url = printer.moonraker_url

    try:
        await asyncio.to_thread(moonraker.upload_gcode, url, file_path, task.file_ref)
        await asyncio.to_thread(moonraker.start_print, url, task.file_ref)
    except moonraker.MoonrakerError as e:
        raise HTTPException(status_code=502, detail=str(e))

    printer.manual_status = "printing"
    printer.manual_job = task.title
    printer.manual_eta_minutes = task.estimated_minutes
    printer.manual_updated_at = datetime.now(timezone.utc)

    db.commit()
    return SendResult(ok=True, message=f"Запущено друк на {printer.name}")
