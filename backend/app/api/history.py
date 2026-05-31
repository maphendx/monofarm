
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
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
    file_name: str | None
    started_at: str
    finished_at: str | None
    duration_minutes: int | None
    result: str
    filament_g: float | None

    class Config:
        from_attributes = True


@router.get("", response_model=list[PrintHistoryOut])
def list_history(
    printer_id: int | None = Query(None),
    result: str | None = Query(None),
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
    return q.limit(limit).all()
