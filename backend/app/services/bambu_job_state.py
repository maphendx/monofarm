"""State machine for Bambu Cloud print jobs.

All status changes driven by MQTT correlation and watchdogs should pass through
this module so the lifecycle remains auditable and illegal jumps are rejected.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core import metrics
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.services.bambu_errors import BambuErrorCode, error_details
from app.services.bambu_observability import event_tags, log_event

log = logging.getLogger(__name__)

TERMINAL_STATUSES = frozenset({
    BambuCloudJobStatus.completed,
    BambuCloudJobStatus.failed,
    BambuCloudJobStatus.cancelled,
    BambuCloudJobStatus.lost,
})

ACTIVE_STATUSES = tuple(status for status in BambuCloudJobStatus if status not in TERMINAL_STATUSES)

_ALLOWED_TRANSITIONS: dict[BambuCloudJobStatus, set[BambuCloudJobStatus]] = {
    BambuCloudJobStatus.queued: {
        BambuCloudJobStatus.validating,
        BambuCloudJobStatus.creating_project,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.validating: {
        BambuCloudJobStatus.creating_project,
        # Moonraker provider: no cloud project stage — straight to upload.
        BambuCloudJobStatus.uploading,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.creating_project: {
        BambuCloudJobStatus.uploading,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.uploading: {
        BambuCloudJobStatus.task_creating,
        # Moonraker provider: upload+start is one step — no cloud task stage.
        BambuCloudJobStatus.printing,
        # Moonraker/U1 explicit start: upload and printer acknowledgement are
        # separate so the UI never calls a file "printing" too early.
        BambuCloudJobStatus.acknowledged,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.task_creating: {
        BambuCloudJobStatus.task_created,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.task_created: {
        BambuCloudJobStatus.acknowledged,
        BambuCloudJobStatus.printing,
        BambuCloudJobStatus.paused,
        BambuCloudJobStatus.completed,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.acknowledged: {
        BambuCloudJobStatus.printing,
        BambuCloudJobStatus.paused,
        BambuCloudJobStatus.completed,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.printing: {
        BambuCloudJobStatus.paused,
        BambuCloudJobStatus.completed,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.paused: {
        BambuCloudJobStatus.printing,
        BambuCloudJobStatus.completed,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    },
    BambuCloudJobStatus.completed: set(),
    # Bambu may emit a stale FAILED snapshot immediately before RUNNING;
    # MQTT correlation can recover that narrow pre-start case.
    BambuCloudJobStatus.failed: {BambuCloudJobStatus.printing},
    BambuCloudJobStatus.cancelled: set(),
    BambuCloudJobStatus.lost: set(),
}

_STATUS_TIMESTAMP_FIELD: dict[BambuCloudJobStatus, str] = {
    BambuCloudJobStatus.task_creating: "uploaded_at",
    BambuCloudJobStatus.task_created: "task_created_at",
    BambuCloudJobStatus.acknowledged: "printer_ack_at",
    BambuCloudJobStatus.printing: "started_printing_at",
    BambuCloudJobStatus.completed: "completed_at",
    BambuCloudJobStatus.failed: "failed_at",
}

TASK_CREATED_ACK_TIMEOUT = timedelta(minutes=10)
ACTIVE_MQTT_TIMEOUT = timedelta(minutes=30)
# U1/Moonraker prints go through slow LAN uploads and the agent-relayed state
# cache only refreshes every ~30s, so a freshly-acknowledged start can take a
# few minutes to surface as `printing`. Two minutes wrongly marked slow-but-OK
# starts as `lost`; five gives the tracker room without stranding real failures.
MOONRAKER_START_TIMEOUT = timedelta(minutes=5)


class BambuJobTransitionError(ValueError):
    """Raised when a job transition violates the explicit state machine."""


def can_transition(from_status: BambuCloudJobStatus, to_status: BambuCloudJobStatus) -> bool:
    return from_status == to_status or to_status in _ALLOWED_TRANSITIONS[from_status]


def transition_job(
    job: BambuCloudJob,
    to_status: BambuCloudJobStatus,
    *,
    reason: str | None = None,
    now: datetime | None = None,
    **field_updates: Any,
) -> BambuCloudJob:
    """Apply a valid transition and timestamp/status metadata to an ORM job."""
    old_status = job.status
    if not can_transition(job.status, to_status):
        raise BambuJobTransitionError(f"Illegal Bambu job transition: {job.status.value} -> {to_status.value}")

    now = now or datetime.now(timezone.utc)
    job.status = to_status
    if reason is not None:
        job.status_reason = reason[:2000]
    for key, value in field_updates.items():
        setattr(job, key, value)

    if to_status in TERMINAL_STATUSES:
        # Free the promised grams; when accounting already consumed them the
        # rows are no longer active and this is a no-op.
        from sqlalchemy.orm import object_session

        from app.services import filament_reservations
        session = object_session(job)
        if session is not None:
            try:
                filament_reservations.release_for_job(session, job.id)
            except Exception:  # noqa: BLE001
                log.warning("filament reservation release failed for job=%s", job.id)

    ts_field = _STATUS_TIMESTAMP_FIELD.get(to_status)
    if ts_field is not None and getattr(job, ts_field) is None:
        setattr(job, ts_field, now)
    job.updated_at = now
    if to_status == BambuCloudJobStatus.printing or to_status in TERMINAL_STATUSES:
        _sync_print_history(job, now=now)
    _emit_transition_observability(job, old_status=old_status, new_status=to_status)
    return job


def _sync_print_history(job: BambuCloudJob, *, now: datetime) -> None:
    try:
        from app.services.print_history_bambu import sync_bambu_cloud_job_history

        sync_bambu_cloud_job_history(job, now=now)
    except Exception:
        log.exception("Failed to sync PrintHistory for Bambu cloud job %s", getattr(job, "id", None))
        raise


def _emit_transition_observability(
    job: BambuCloudJob,
    *,
    old_status: BambuCloudJobStatus,
    new_status: BambuCloudJobStatus,
) -> None:
    if old_status == new_status:
        return

    event_by_status = {
        BambuCloudJobStatus.acknowledged: "bambu.mqtt.job.acknowledged",
        BambuCloudJobStatus.completed: "bambu.cloud.job.completed",
        BambuCloudJobStatus.failed: "bambu.cloud.job.failed",
        BambuCloudJobStatus.lost: "bambu.cloud.job.lost",
    }
    event = event_by_status.get(new_status)
    if event is None:
        return

    level = logging.WARNING if new_status in (BambuCloudJobStatus.failed, BambuCloudJobStatus.lost) else logging.INFO
    log_event(
        log,
        level,
        event,
        org_id=job.organization_id,
        printer_id=job.printer_id,
        dev_id=job.printer_bambu_dev_id,
        job_id=job.id,
        correlation_id=job.correlation_id,
        old_status=old_status.value,
        new_status=new_status.value,
        error_code=job.error_code,
    )

    if new_status == BambuCloudJobStatus.completed:
        metrics.increment("bambu.cloud.job.completed.count", tags=event_tags(org_id=job.organization_id, region=job.region))
    elif new_status == BambuCloudJobStatus.failed:
        metrics.increment(
            "bambu.cloud.job.failed.count",
            tags=event_tags(org_id=job.organization_id, region=job.region, error_code=job.error_code),
        )
    elif new_status == BambuCloudJobStatus.lost:
        metrics.increment("bambu.cloud.job.lost.count", tags=event_tags(org_id=job.organization_id, region=job.region))


def mark_lost_jobs(
    db: Session,
    *,
    now: datetime | None = None,
    task_created_timeout: timedelta = TASK_CREATED_ACK_TIMEOUT,
    active_mqtt_timeout: timedelta = ACTIVE_MQTT_TIMEOUT,
    limit: int = 100,
) -> int:
    """Mark cloud jobs as lost when printer telemetry never arrives or goes stale."""
    now = now or datetime.now(timezone.utc)
    lost = 0

    task_created_cutoff = now - task_created_timeout
    task_created_rows = (
        db.query(BambuCloudJob)
        .filter(
            BambuCloudJob.status == BambuCloudJobStatus.task_created,
            BambuCloudJob.printer_ack_at.is_(None),
            BambuCloudJob.task_created_at.isnot(None),
            BambuCloudJob.task_created_at < task_created_cutoff,
        )
        .order_by(BambuCloudJob.task_created_at.asc())
        .limit(limit)
        .all()
    )
    for job in task_created_rows:
        transition_job(
            job,
            BambuCloudJobStatus.lost,
            reason="Printer did not acknowledge Bambu Cloud task before timeout",
            now=now,
            error_code=BambuErrorCode.MQTT_ACK_TIMEOUT.value,
            error_details_json=error_details(
                BambuErrorCode.MQTT_ACK_TIMEOUT,
                stage="task_ack",
                timeout_seconds=int(task_created_timeout.total_seconds()),
            ),
        )
        lost += 1

    remaining = max(limit - lost, 0)
    if remaining:
        moonraker_cutoff = now - MOONRAKER_START_TIMEOUT
        moonraker_rows = (
            db.query(BambuCloudJob)
            .filter(
                BambuCloudJob.dispatch_mode == "moonraker",
                BambuCloudJob.status == BambuCloudJobStatus.acknowledged,
                BambuCloudJob.started_printing_at.is_(None),
                BambuCloudJob.printer_ack_at.isnot(None),
                BambuCloudJob.printer_ack_at < moonraker_cutoff,
            )
            .order_by(BambuCloudJob.printer_ack_at.asc())
            .limit(remaining)
            .all()
        )
        for job in moonraker_rows:
            transition_job(
                job,
                BambuCloudJobStatus.lost,
                reason="Принтер не почав відповідний файл після підтвердження запуску",
                now=now,
                error_code=BambuErrorCode.MOONRAKER_START_TIMEOUT.value,
                error_details_json=error_details(
                    BambuErrorCode.MOONRAKER_START_TIMEOUT,
                    stage="moonraker_start_ack",
                    timeout_seconds=int(MOONRAKER_START_TIMEOUT.total_seconds()),
                ),
            )
            lost += 1

    remaining = max(limit - lost, 0)
    if remaining:
        mqtt_cutoff = now - active_mqtt_timeout
        stale_rows = (
            db.query(BambuCloudJob)
            .filter(
                BambuCloudJob.status.in_(
                    (
                        BambuCloudJobStatus.acknowledged,
                        BambuCloudJobStatus.printing,
                        BambuCloudJobStatus.paused,
                    )
                ),
                BambuCloudJob.last_mqtt_at.isnot(None),
                BambuCloudJob.last_mqtt_at < mqtt_cutoff,
            )
            .order_by(BambuCloudJob.last_mqtt_at.asc())
            .limit(remaining)
            .all()
        )
        for job in stale_rows:
            transition_job(
                job,
                BambuCloudJobStatus.lost,
                reason="Printer MQTT telemetry stopped before job reached a terminal state",
                now=now,
                error_code=BambuErrorCode.MQTT_NOT_CONNECTED.value,
                error_details_json=error_details(
                    BambuErrorCode.MQTT_NOT_CONNECTED,
                    stage="active_mqtt",
                    timeout_seconds=int(active_mqtt_timeout.total_seconds()),
                ),
            )
            lost += 1

    if lost:
        db.commit()
    return lost
