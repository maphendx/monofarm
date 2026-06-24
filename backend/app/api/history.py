from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.api.deps import get_current_org
from app.core.db import get_db
from app.models.organization import Organization
from app.models.print_history import PrintHistory

router = APIRouter(prefix="/history", tags=["history"])


class PrintHistoryOut(BaseModel):
    id: int
    printer_id: int
    printer_name: str
    printer_kind: str | None = None
    file_name: str | None
    started_at: datetime
    finished_at: datetime | None
    duration_minutes: int | None
    result: str
    result_reason: str | None = None
    filament_g: float | None
    pauses: list | None = None
    slots_used: list | None = None
    material_cost: float | None = None
    source: str | None = None
    created_by_user_id: int | None = None
    file_sha256: str | None = None
    bambu_cloud_job_id: int | None = None
    bambu_task_id: str | None = None
    bambu_project_id: str | None = None

    model_config = ConfigDict(from_attributes=True)


@router.get("", response_model=list[PrintHistoryOut])
def list_history(
    printer_id: int | None = Query(None),
    result: str | None = Query(None),
    start: date | None = Query(None),
    end: date | None = Query(None),
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrintHistory]:
    q = (
        db.query(PrintHistory)
        .filter(PrintHistory.organization_id == org.id)
        .order_by(PrintHistory.started_at.desc())
    )
    if printer_id:
        q = q.filter(PrintHistory.printer_id == printer_id)
    if result:
        q = q.filter(PrintHistory.result == result)
    if start:
        q = q.filter(PrintHistory.started_at >= datetime.combine(start, time.min, tzinfo=timezone.utc))
    if end:
        q = q.filter(PrintHistory.started_at < datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc))
    return q.limit(limit).all()
