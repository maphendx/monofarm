from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_, func, cast
from sqlalchemy.dialects.postgresql import JSONPATH
from sqlalchemy.types import JSON

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.print_history import PrintHistory
from app.models.user import User, UserRole
from app.schemas.print_output import HistoryOutputPayload, PrintOutputContext, PrintOutputOut

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
    output_report: PrintOutputOut | None = None

    model_config = ConfigDict(from_attributes=True)


@router.get("", response_model=list[PrintHistoryOut])
def list_history(
    run_id: int | None = Query(None, ge=1),
    printer_id: int | None = Query(None),
    result: str | None = Query(None),
    start: date | None = Query(None),
    end: date | None = Query(None),
    limit: int = Query(100, le=5000),
    unreported: bool = False,
    skip: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrintHistory]:
    q = (
        db.query(PrintHistory)
        .filter(PrintHistory.organization_id == org.id)
        .order_by(PrintHistory.started_at.desc(), PrintHistory.id.desc())
    )
    if run_id:
        q = q.filter(PrintHistory.id == run_id)
    if printer_id:
        q = q.filter(PrintHistory.printer_id == printer_id)
    if result:
        q = q.filter(PrintHistory.result == result)
    if unreported:
        q = q.filter(PrintHistory.result != "in_progress", or_(
            PrintHistory.output_report.is_(None),
            PrintHistory.output_report == JSON.NULL,
            PrintHistory.output_report["accounting_state"].astext == "pending",
            and_(PrintHistory.output_report["accounting_state"].astext.is_(None),
                 PrintHistory.output_report["warehouse_id"].astext.is_(None),
                 PrintHistory.output_report["plan"].astext.is_(None),
                 func.jsonb_path_exists(PrintHistory.output_report, cast('$.items[*] ? (@.pieces_ok > 0)', JSONPATH))),
        ))
    if start:
        q = q.filter(PrintHistory.started_at >= datetime.combine(start, time.min, tzinfo=timezone.utc))
    if end:
        q = q.filter(PrintHistory.started_at < datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc))
    return q.offset(skip).limit(limit).all()


def _require_history(history_id: int, db: Session, org: Organization) -> PrintHistory:
    history = (
        db.query(PrintHistory)
        .filter(PrintHistory.id == history_id, PrintHistory.organization_id == org.id)
        .first()
    )
    if not history:
        raise HTTPException(status_code=404, detail="Запис історії не знайдено")
    return history


@router.get("/{history_id}/output-context", response_model=PrintOutputContext)
def history_output_context(
    history_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrintOutputContext:
    """Context for the history-page accounting form (plan as a prefill hint)."""
    from app.services.print_output import run_plan

    history = _require_history(history_id, db, org)
    return PrintOutputContext(
        history_id=history.id,
        file_name=history.file_name,
        output=history.output_report,
        plan=run_plan(db, history),
        filament_g=history.filament_g,
        material_cost=float(history.material_cost) if history.material_cost else None,
    )


@router.post("/{history_id}/output")
def history_attach_output(
    history_id: int,
    payload: HistoryOutputPayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """«Прив'язати й оприбуткувати» — account a finished run that has no report yet.

    The physical bed state is untouched: a run can be accounted long after the
    printer moved on. Idempotent for a retried request_id; 409 for anything else.
    """
    from app.services.print_output import attach_history_output, replayed_history_output

    history = (
        db.query(PrintHistory)
        .filter(PrintHistory.id == history_id, PrintHistory.organization_id == org.id)
        .with_for_update()
        .first()
    )
    if not history:
        raise HTTPException(status_code=404, detail="Запис історії не знайдено")
    if replayed_history_output(history, payload):
        return {"ok": True, "action": "attach_output"}
    if payload.output.warehouse_id:
        require_warehouse_full(org)
    attach_history_output(db, org.id, history, payload, user.id)
    db.commit()
    return {"ok": True, "action": "attach_output"}
