from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from starlette.requests import Request
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.core.ratelimit import limiter
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole
from app.schemas.bambu_jobs import (
    BambuCloudJobOut,
    BambuHealthAuth,
    BambuHealthJobs,
    BambuHealthMqtt,
    BambuHealthOut,
    BambuHealthPrinters,
    BambuJobListOut,
    BambuRetryResult,
)
from app.services.bambu_errors import BambuErrorCode, error_details, is_retryable
from app.services.bambu_job_state import ACTIVE_MQTT_TIMEOUT, TASK_CREATED_ACK_TIMEOUT, transition_job
from app.workers.bambu_jobs import MAX_RETRY_COUNT

router = APIRouter(tags=["bambu-jobs"])

_ACTIVE_STATUSES = (
    BambuCloudJobStatus.queued,
    BambuCloudJobStatus.validating,
    BambuCloudJobStatus.creating_project,
    BambuCloudJobStatus.uploading,
    BambuCloudJobStatus.task_creating,
    BambuCloudJobStatus.task_created,
    BambuCloudJobStatus.acknowledged,
    BambuCloudJobStatus.printing,
    BambuCloudJobStatus.paused,
)

def _get_org_job(db: Session, org_id: int, job_id: int) -> BambuCloudJob:
    job = (
        db.query(BambuCloudJob)
        .filter(BambuCloudJob.id == job_id, BambuCloudJob.organization_id == org_id)
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="Bambu job not found")
    return job


def _attach_printer_display(db: Session, job: BambuCloudJob) -> BambuCloudJob:
    printer = db.get(Printer, job.printer_id)
    if printer is not None:
        setattr(job, "printer_name", printer.name)
        setattr(job, "printer_model", printer.bambu_model)
    return job


def _attach_printer_display_many(db: Session, jobs: list[BambuCloudJob]) -> list[BambuCloudJob]:
    printer_ids = {job.printer_id for job in jobs}
    if not printer_ids:
        return jobs
    printers = db.query(Printer).filter(Printer.id.in_(printer_ids)).all()
    by_id = {printer.id: printer for printer in printers}
    for job in jobs:
        printer = by_id.get(job.printer_id)
        if printer is not None:
            setattr(job, "printer_name", printer.name)
            setattr(job, "printer_model", printer.bambu_model)
    return jobs


def _can_retry_job(job: BambuCloudJob) -> bool:
    if job.status != BambuCloudJobStatus.failed:
        return False
    details = job.error_details_json or {}
    return is_retryable(job.error_code) or bool(details.get("retryable"))


@router.get("/bambu-jobs/{job_id}", response_model=BambuCloudJobOut)
def get_bambu_job(
    job_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> BambuCloudJob:
    return _attach_printer_display(db, _get_org_job(db, org.id, job_id))


@router.get("/bambu-jobs", response_model=BambuJobListOut)
def list_bambu_jobs(
    printer_id: int | None = None,
    job_status: list[BambuCloudJobStatus] | None = Query(default=None, alias="status"),
    statuses: list[BambuCloudJobStatus] | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> BambuJobListOut:
    q = db.query(BambuCloudJob).filter(BambuCloudJob.organization_id == org.id)
    if printer_id is not None:
        q = q.filter(BambuCloudJob.printer_id == printer_id)
    requested_statuses = job_status or statuses
    if requested_statuses:
        q = q.filter(BambuCloudJob.status.in_(requested_statuses))

    total = q.with_entities(func.count(BambuCloudJob.id)).scalar() or 0
    items = q.order_by(BambuCloudJob.created_at.desc(), BambuCloudJob.id.desc()).offset(offset).limit(limit).all()
    _attach_printer_display_many(db, items)
    return BambuJobListOut(items=items, total=total, limit=limit, offset=offset)


@router.post("/bambu-jobs/{job_id}/retry", response_model=BambuRetryResult)
@limiter.limit("10/minute")
def retry_bambu_job(
    request: Request,
    job_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> BambuRetryResult:
    _ = request
    job = _get_org_job(db, org.id, job_id)
    if not _can_retry_job(job):
        raise HTTPException(status_code=409, detail=f"Job cannot be retried from status '{job.status.value}'")
    if (job.retry_count or 0) >= MAX_RETRY_COUNT:
        raise HTTPException(status_code=409, detail="Job retry limit reached")

    job.status = BambuCloudJobStatus.queued
    job.status_reason = "Queued for retry"
    job.error_code = None
    job.error_details_json = None
    job.failed_at = None
    job.retry_count = (job.retry_count or 0) + 1
    job.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(job)
    # Instant re-dispatch in the web process: moonraker needs the agent tunnel
    # (absent in the worker), and cloud jobs shouldn't wait out the worker's
    # crash-recovery grace window.
    if job.dispatch_mode == "moonraker":
        from app.services.moonraker_dispatch import dispatch_moonraker_job
        background_tasks.add_task(dispatch_moonraker_job, job.id)
    else:
        from app.workers.bambu_jobs import run_bambu_cloud_job
        background_tasks.add_task(run_bambu_cloud_job, job.id)
    return BambuRetryResult(ok=True, job=job, message="Job queued for retry")


@router.post("/bambu-jobs/{job_id}/cancel", response_model=BambuCloudJobOut)
@limiter.limit("20/minute")
def cancel_bambu_job(
    request: Request,
    job_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> BambuCloudJob:
    _ = request
    job = _get_org_job(db, org.id, job_id)
    if job.status not in _ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail=f"Job cannot be cancelled from status '{job.status.value}'")

    transition_job(
        job,
        BambuCloudJobStatus.cancelled,
        reason="Cancelled by user before dispatch completion",
        error_code=BambuErrorCode.PRINT_CANCELLED_BY_USER.value,
        error_details_json=error_details(
            BambuErrorCode.PRINT_CANCELLED_BY_USER,
            retryable=False,
            source="api",
        ),
    )
    db.commit()
    db.refresh(job)
    return _attach_printer_display(db, job)


@router.get("/printers/{printer_id}/active-job", response_model=BambuCloudJobOut | None)
def get_printer_active_bambu_job(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> BambuCloudJob | None:
    printer = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not printer:
        raise HTTPException(status_code=404, detail="Printer not found")
    job = (
        db.query(BambuCloudJob)
        .filter(
            BambuCloudJob.organization_id == org.id,
            BambuCloudJob.printer_id == printer_id,
            BambuCloudJob.status.in_(_ACTIVE_STATUSES),
        )
        .order_by(BambuCloudJob.created_at.desc(), BambuCloudJob.id.desc())
        .first()
    )
    return _attach_printer_display(db, job) if job is not None else None


@router.get("/orgs/me/bambu-health", response_model=BambuHealthOut)
def get_bambu_health(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> BambuHealthOut:
    from app.services import bambu

    now = datetime.now(timezone.utc)
    recent_cutoff = now - timedelta(hours=24)
    task_ack_cutoff = now - TASK_CREATED_ACK_TIMEOUT
    mqtt_cutoff = now - ACTIVE_MQTT_TIMEOUT

    printers = (
        db.query(Printer)
        .filter(Printer.organization_id == org.id, Printer.is_active.is_(True))
        .all()
    )
    bambu_cloud_printers = [
        printer
        for printer in printers
        if printer.kind == PrinterKind.bambu and printer.bambu_dev_id and not printer.bambu_lan_mode
    ]
    online = 0
    offline = 0
    last_message_at: datetime | None = None
    for printer in bambu_cloud_printers:
        state = bambu.get_cached_state(printer.bambu_dev_id or "")
        if state.get("state") == "offline":
            offline += 1
        else:
            online += 1
        seen = _parse_dt(state.get("last_message_at"))
        if seen and (last_message_at is None or seen > last_message_at):
            last_message_at = seen

    queued_count = _count_jobs(db, org.id, BambuCloudJob.status == BambuCloudJobStatus.queued)
    active_count = _count_jobs(db, org.id, BambuCloudJob.status.in_(_ACTIVE_STATUSES))
    lost_count = _count_jobs(db, org.id, BambuCloudJob.status == BambuCloudJobStatus.lost)
    stuck_count = _count_jobs(
        db,
        org.id,
        or_(
            and_(
                BambuCloudJob.status == BambuCloudJobStatus.task_created,
                BambuCloudJob.printer_ack_at.is_(None),
                BambuCloudJob.task_created_at.isnot(None),
                BambuCloudJob.task_created_at < task_ack_cutoff,
            ),
            and_(
                BambuCloudJob.status.in_(
                    (
                        BambuCloudJobStatus.acknowledged,
                        BambuCloudJobStatus.printing,
                        BambuCloudJobStatus.paused,
                    )
                ),
                BambuCloudJob.last_mqtt_at.isnot(None),
                BambuCloudJob.last_mqtt_at < mqtt_cutoff,
            ),
        ),
    )
    recent_failures = _count_jobs(
        db,
        org.id,
        BambuCloudJob.status == BambuCloudJobStatus.failed,
        BambuCloudJob.failed_at.isnot(None),
        BambuCloudJob.failed_at >= recent_cutoff,
    )
    tracked_devices = sorted(dev for dev, oid in bambu._dev_to_org.items() if oid == org.id)
    return BambuHealthOut(
        auth=BambuHealthAuth(
            configured=bool(org.bambu_access_token or org.bambu_auth_type or org.bambu_refresh_token),
            auth_type=org.bambu_auth_type.value if org.bambu_auth_type else None,
            reauth_required=bool(org.bambu_reauth_required),
            last_success_at=org.bambu_last_auth_success_at,
            last_error=org.bambu_last_auth_error,
            access_token_expires_at=org.bambu_access_token_expires_at,
            region=org.bambu_region or None,
        ),
        mqtt=BambuHealthMqtt(
            connected=org.id in bambu._mqtt_clients,
            last_message_at=last_message_at,
            tracked_devices=tracked_devices,
        ),
        printers=BambuHealthPrinters(
            total=len(printers),
            bambu_cloud=len(bambu_cloud_printers),
            online=online,
            offline=offline,
        ),
        jobs=BambuHealthJobs(
            active=active_count,
            stuck_or_lost=stuck_count + lost_count,
            recent_failures=recent_failures,
            queued=queued_count,
        ),
    )


def _count_jobs(db: Session, org_id: int, *filters) -> int:
    return (
        db.query(func.count(BambuCloudJob.id))
        .filter(BambuCloudJob.organization_id == org_id, *filters)
        .scalar()
        or 0
    )


def _parse_dt(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)
    return None
