from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.plan import PlanEntry
from app.models.printer import Printer
from app.models.printer_group import PrinterGroup
from app.models.task import PrintTask
from app.models.user import UserRole
from app.schemas.plan import (
    CalendarDayOut,
    CalendarEntryOut,
    CalendarLaneOut,
    PlanEntryCreate,
    PlanEntryOut,
    PlanEntryUpdate,
)
from app.services import moonraker
from app.services.schedule_conflict import detect_conflicts, entry_end_time


UPLOADS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "uploads"

_CALENDAR_MAX_DAYS = 60


class SendResult(BaseModel):
    ok: bool
    message: str


router = APIRouter(prefix="/plan", tags=["plan"])


from app.api.tasks import _to_out as task_to_out

def _to_out(
    entry: PlanEntry,
    db: Session,
    org_id: int,
    conflict_ids: set[int] | None = None,
) -> PlanEntryOut:
    conflict = entry.id in (conflict_ids or set())
    printer = entry.printer
    return PlanEntryOut(
        id=entry.id,
        plan_date=entry.plan_date,
        printer_id=entry.printer_id,
        printer_name=printer.name if printer else str(entry.printer_id),
        task_id=entry.task_id,
        task=task_to_out(entry.task, db, org_id),
        sequence=entry.sequence,
        note=entry.note,
        done=entry.done,
        created_at=entry.created_at,
        start_time=entry.start_time,
        schedule_mode=entry.schedule_mode,
        window_start_at=entry.window_start_at,
        window_end_at=entry.window_end_at,
        priority=entry.priority,
        blocked_reason=entry.blocked_reason,
        conflict=conflict,
        end_time=entry_end_time(entry),
    )


def _load_entries(
    db: Session,
    org_id: int,
    from_date: date,
    to_date: date,
) -> list[PlanEntry]:
    return (
        db.query(PlanEntry)
        .options(joinedload(PlanEntry.printer), joinedload(PlanEntry.task))
        .filter(
            PlanEntry.organization_id == org_id,
            PlanEntry.plan_date >= from_date,
            PlanEntry.plan_date <= to_date,
        )
        .order_by(PlanEntry.printer_id, PlanEntry.plan_date, PlanEntry.sequence, PlanEntry.created_at)
        .all()
    )


def _conflict_ids_for(entries: list[PlanEntry]) -> set[int]:
    """Detect conflicts per (printer_id, plan_date) bucket — never cross-printer."""
    by_group: dict[tuple[int, date], list[PlanEntry]] = defaultdict(list)
    for e in entries:
        by_group[(e.printer_id, e.plan_date)].append(e)
    result: set[int] = set()
    for group in by_group.values():
        result.update(detect_conflicts(group))
    return result


@router.get("/calendar", response_model=list[CalendarLaneOut])
def get_calendar(
    start: date | None = None,
    end: date | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[CalendarLaneOut]:
    """Week (or any date-range) calendar view: one lane per printer, grouped by day.

    Defaults to the current Monday–Sunday week. Returns ALL org printers — lanes
    without entries are included as empty so the UI can render all printer rows.
    Max range: 60 days.
    """
    today = date.today()
    if start is None:
        start = today - timedelta(days=today.weekday())  # Monday of current week
    if end is None:
        end = start + timedelta(days=6)

    span = (end - start).days + 1
    if span < 1 or span > _CALENDAR_MAX_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"Date range must be 1–{_CALENDAR_MAX_DAYS} days.",
        )

    # Load all printers sorted by group order then printer order
    group_names: dict[int, str] = {}
    group_colors: dict[int, str | None] = {}
    for g in db.query(PrinterGroup).filter_by(organization_id=org.id).all():
        group_names[g.id] = g.name
        group_colors[g.id] = g.color
    printers = (
        db.query(Printer)
        .filter(Printer.organization_id == org.id)
        .outerjoin(PrinterGroup, Printer.group_id == PrinterGroup.id)
        .order_by(
            PrinterGroup.sort_order.nulls_last(),
            Printer.sort_order,
            Printer.id,
        )
        .all()
    )

    entries = _load_entries(db, org.id, start, end)
    conflict_ids = _conflict_ids_for(entries)

    # Group entries by printer_id → plan_date
    by_printer: dict[int, dict[date, list[PlanEntry]]] = {p.id: {} for p in printers}
    for e in entries:
        if e.printer_id in by_printer:
            by_printer[e.printer_id].setdefault(e.plan_date, []).append(e)

    result: list[CalendarLaneOut] = []
    for printer in printers:
        day_map = by_printer[printer.id]
        days: list[CalendarDayOut] = [
            CalendarDayOut(
                printer_id=printer.id,
                printer_name=printer.name,
                plan_date=d,
                entries=[
                    CalendarEntryOut(**_to_out(e, db, org.id, conflict_ids).model_dump())
                    for e in day_entries
                ],
            )
            for d, day_entries in sorted(day_map.items())
        ]
        result.append(
            CalendarLaneOut(
                printer_id=printer.id,
                printer_name=printer.name,
                printer_kind=printer.kind.value,
                group_id=printer.group_id,
                group_name=group_names.get(printer.group_id) if printer.group_id else None,
                group_color=group_colors.get(printer.group_id) if printer.group_id else None,
                days=days,
            )
        )
    return result


@router.get("", response_model=list[PlanEntryOut])
def get_plan(
    plan_date: date | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PlanEntryOut]:
    target = plan_date or date.today()
    entries = _load_entries(db, org.id, target, target)
    conflict_ids = _conflict_ids_for(entries)
    return [_to_out(e, db, org.id, conflict_ids) for e in entries]


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

    existing_count = (
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
        sequence=existing_count,
        note=payload.note,
        start_time=payload.start_time,
        schedule_mode=payload.schedule_mode,
        window_start_at=payload.window_start_at,
        window_end_at=payload.window_end_at,
        priority=payload.priority,
    )
    db.add(entry)
    db.commit()
    # Reload with relationships eager-loaded
    entry = (
        db.query(PlanEntry)
        .options(joinedload(PlanEntry.printer), joinedload(PlanEntry.task))
        .filter(PlanEntry.id == entry.id)
        .one()
    )
    return _to_out(entry, db, org.id)


@router.patch("/{entry_id}", response_model=PlanEntryOut)
def update_entry(
    entry_id: int,
    payload: PlanEntryUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PlanEntryOut:
    entry = (
        db.query(PlanEntry)
        .options(joinedload(PlanEntry.printer), joinedload(PlanEntry.task))
        .filter(PlanEntry.id == entry_id, PlanEntry.organization_id == org.id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Plan entry not found")

    updates = payload.model_dump(exclude_unset=True)

    # printer_id change requires org-scoped validation
    if "printer_id" in updates and updates["printer_id"] is not None:
        new_printer = db.query(Printer).filter(
            Printer.id == updates["printer_id"],
            Printer.organization_id == org.id,
        ).first()
        if not new_printer:
            raise HTTPException(status_code=404, detail="Printer not found")

    for field, value in updates.items():
        setattr(entry, field, value)

    db.commit()
    db.refresh(entry)
    return _to_out(entry, db, org.id)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
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

    try:
        await moonraker.async_upload_gcode(printer.moonraker_url, file_path, task.file_ref)
        await moonraker.async_start_print(printer.moonraker_url, task.file_ref)
    except moonraker.MoonrakerError as e:
        raise HTTPException(status_code=502, detail=str(e))

    printer.manual_status = "printing"
    printer.manual_job = task.title
    printer.manual_eta_minutes = task.estimated_minutes
    printer.manual_updated_at = datetime.now(timezone.utc)

    db.commit()
    return SendResult(ok=True, message=f"Запущено друк на {printer.name}")
