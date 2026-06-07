"""PrintHistory integration for Bambu Cloud print jobs."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session, object_session

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.print_history import PrintHistory
from app.models.printer import Printer
from app.services.bambu_errors import to_user_message
from app.services.bambu_observability import log_event

log = logging.getLogger(__name__)

_TERMINAL_STATUSES = {
    BambuCloudJobStatus.completed,
    BambuCloudJobStatus.failed,
    BambuCloudJobStatus.cancelled,
    BambuCloudJobStatus.lost,
}


def sync_bambu_cloud_job_history(
    job: BambuCloudJob,
    *,
    db: Session | None = None,
    now: datetime | None = None,
) -> PrintHistory | None:
    """Create or update the single PrintHistory row owned by a cloud job.

    The caller owns transaction boundaries. Detached/transient jobs are ignored
    because they cannot be linked idempotently by primary key.
    """
    if job.id is None or job.status not in {BambuCloudJobStatus.printing, *_TERMINAL_STATUSES}:
        return None

    db = db or object_session(job)
    if db is None:
        return None

    now = now or datetime.now(timezone.utc)
    entry = (
        db.query(PrintHistory)
        .filter(
            PrintHistory.organization_id == job.organization_id,
            PrintHistory.bambu_cloud_job_id == job.id,
        )
        .first()
    )
    printer = db.get(Printer, job.printer_id)
    started_at = job.started_printing_at or job.created_at or now

    if entry is None:
        entry = PrintHistory(
            organization_id=job.organization_id,
            printer_id=job.printer_id,
            printer_name=printer.name if printer is not None else f"Printer #{job.printer_id}",
            file_name=job.file_name,
            started_at=started_at,
            result="in_progress",
            source="cloud",
            bambu_cloud_job_id=job.id,
        )
        db.add(entry)
        db.flush()

    entry.organization_id = job.organization_id
    entry.printer_id = job.printer_id
    entry.printer_name = printer.name if printer is not None else entry.printer_name
    entry.file_name = job.file_name
    entry.file_sha256 = job.file_sha256
    entry.created_by_user_id = job.created_by_user_id
    entry.source = "cloud"
    entry.bambu_cloud_job_id = job.id
    entry.bambu_task_id = job.bambu_task_id
    entry.bambu_project_id = job.bambu_project_id
    if entry.started_at is None or job.started_printing_at is not None:
        entry.started_at = started_at

    if job.status in _TERMINAL_STATUSES:
        _finalize_entry(entry, job, now=now)
    elif job.status == BambuCloudJobStatus.printing:
        entry.result = "in_progress"
        entry.finished_at = None
        entry.duration_minutes = None
        entry.result_reason = _trim_reason(job.status_reason)

    return entry


def _finalize_entry(entry: PrintHistory, job: BambuCloudJob, *, now: datetime) -> None:
    entry.result, reason = _result_for_status(job)
    entry.result_reason = _trim_reason(reason)
    entry.finished_at = _finish_time_for_status(job) or now
    entry.duration_minutes = _duration_minutes(entry.started_at, entry.finished_at)
    log_event(
        log,
        logging.INFO,
        "bambu.cloud.history.finalized",
        org_id=job.organization_id,
        printer_id=job.printer_id,
        dev_id=job.printer_bambu_dev_id,
        job_id=job.id,
        correlation_id=job.correlation_id,
        status=job.status.value,
        result=entry.result,
    )


def _result_for_status(job: BambuCloudJob) -> tuple[str, str | None]:
    if job.status == BambuCloudJobStatus.completed:
        return "completed", job.status_reason or "Bambu Cloud print completed"
    if job.status == BambuCloudJobStatus.failed:
        if job.error_code:
            return "failed", to_user_message(job.error_code)
        return "failed", job.error_msg or job.status_reason or "Bambu Cloud print failed"
    if job.status == BambuCloudJobStatus.cancelled:
        if job.error_code:
            return "cancelled", to_user_message(job.error_code)
        return "cancelled", job.status_reason or "Bambu Cloud print cancelled"
    if job.status == BambuCloudJobStatus.lost:
        if job.error_code:
            return "failed", to_user_message(job.error_code)
        return "failed", job.status_reason or "Bambu Cloud job lost printer contact"
    return "in_progress", job.status_reason


def _finish_time_for_status(job: BambuCloudJob) -> datetime | None:
    if job.status == BambuCloudJobStatus.completed:
        return job.completed_at
    if job.status == BambuCloudJobStatus.failed:
        return job.failed_at
    if job.status in {BambuCloudJobStatus.cancelled, BambuCloudJobStatus.lost}:
        return job.updated_at
    return None


def _duration_minutes(started_at: datetime, finished_at: datetime | None) -> int | None:
    if finished_at is None:
        return None
    delta = _aware(finished_at) - _aware(started_at)
    return max(0, int(delta.total_seconds() / 60))


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _trim_reason(reason: str | None) -> str | None:
    if not reason:
        return None
    return reason[:255]
