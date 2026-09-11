from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.services import moonraker, print_tracker
from app.services.bambu_errors import BambuErrorCode, to_user_message
from app.services.bambu_job_state import mark_lost_jobs, transition_job


def _make_printer(db_session, org_id: int, *, kind: PrinterKind = PrinterKind.bambu, dev_id: str = "DEV-HIST") -> Printer:
    printer = Printer(
        organization_id=org_id,
        name="History Printer",
        kind=kind,
        bambu_dev_id=dev_id if kind == PrinterKind.bambu else None,
        moonraker_url="http://moonraker.local" if kind != PrinterKind.bambu else None,
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)
    return printer


def _make_job(
    db_session,
    *,
    org_id: int,
    printer_id: int,
    dev_id: str = "DEV-HIST",
    file_name: str = "history.3mf",
    status: BambuCloudJobStatus = BambuCloudJobStatus.task_created,
    suffix: str = "1",
    created_by_user_id: int | None = None,
) -> BambuCloudJob:
    job = BambuCloudJob(
        organization_id=org_id,
        printer_id=printer_id,
        created_by_user_id=created_by_user_id,
        printer_bambu_dev_id=dev_id,
        file_name=file_name,
        file_sha256=f"{suffix}".zfill(64),
        status=status,
        correlation_id=f"hist-corr-{printer_id}-{suffix}",
        idempotency_key=f"hist-idem-{printer_id}-{suffix}",
        bambu_task_id=f"task-{suffix}",
        bambu_project_id=f"project-{suffix}",
        task_created_at=datetime.now(timezone.utc),
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def _history_rows(db_session, job: BambuCloudJob) -> list[PrintHistory]:
    return (
        db_session.query(PrintHistory)
        .filter(PrintHistory.bambu_cloud_job_id == job.id)
        .order_by(PrintHistory.id.asc())
        .all()
    )


def test_bambu_cloud_job_printing_then_completed_creates_single_history(db_session, test_org, operator_user):
    printer = _make_printer(db_session, test_org.id)
    job = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer.id,
        created_by_user_id=operator_user.id,
    )
    started = datetime.now(timezone.utc).replace(microsecond=0)
    finished = started + timedelta(minutes=42)

    transition_job(job, BambuCloudJobStatus.printing, reason="Printer reports print progress", now=started)
    db_session.commit()
    transition_job(job, BambuCloudJobStatus.completed, reason="Printer reports print completed", now=finished)
    db_session.commit()

    rows = _history_rows(db_session, job)
    assert len(rows) == 1
    entry = rows[0]
    assert entry.organization_id == test_org.id
    assert entry.printer_id == printer.id
    assert entry.printer_name == printer.name
    assert entry.created_by_user_id == operator_user.id
    assert entry.file_name == "history.3mf"
    assert entry.file_sha256 == "1".zfill(64)
    assert entry.source == "cloud"
    assert entry.result == "completed"
    assert entry.result_reason == "Printer reports print completed"
    assert entry.bambu_cloud_job_id == job.id
    assert entry.bambu_task_id == "task-1"
    assert entry.bambu_project_id == "project-1"
    assert entry.started_at == started.replace(tzinfo=None)
    assert entry.finished_at == finished.replace(tzinfo=None)
    assert entry.duration_minutes == 42


def test_bambu_cloud_failed_retry_success_uses_one_history_per_job(db_session, test_org):
    printer = _make_printer(db_session, test_org.id)
    first = _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="retry-a")
    second = _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="retry-b")
    first_start = datetime.now(timezone.utc).replace(microsecond=0)
    second_start = first_start + timedelta(minutes=10)

    transition_job(first, BambuCloudJobStatus.printing, now=first_start)
    transition_job(
        first,
        BambuCloudJobStatus.failed,
        reason="Dispatch failed",
        now=first_start + timedelta(minutes=3),
        error_msg="Temporary Bambu Cloud error",
        error_details_json={"retryable": True},
    )
    transition_job(second, BambuCloudJobStatus.printing, now=second_start)
    transition_job(second, BambuCloudJobStatus.completed, now=second_start + timedelta(minutes=5))
    db_session.commit()

    first_history = _history_rows(db_session, first)
    second_history = _history_rows(db_session, second)
    assert len(first_history) == 1
    assert len(second_history) == 1
    assert first_history[0].result == "failed"
    assert first_history[0].result_reason == "Temporary Bambu Cloud error"
    assert second_history[0].result == "completed"


def test_bambu_cloud_terminal_statuses_map_history_results(db_session, test_org):
    printer = _make_printer(db_session, test_org.id)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    failed = _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="failed")
    cancelled = _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="cancelled")
    lost = _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="lost")

    transition_job(failed, BambuCloudJobStatus.failed, reason="Task creation failed", now=now, error_msg="No plate")
    transition_job(cancelled, BambuCloudJobStatus.cancelled, reason="Cancelled by user", now=now + timedelta(minutes=1))
    transition_job(lost, BambuCloudJobStatus.lost, reason="Printer contact lost", now=now + timedelta(minutes=2))
    db_session.commit()

    failed_entry = _history_rows(db_session, failed)[0]
    cancelled_entry = _history_rows(db_session, cancelled)[0]
    lost_entry = _history_rows(db_session, lost)[0]
    assert failed_entry.result == "failed"
    assert failed_entry.result_reason == "No plate"
    assert cancelled_entry.result == "cancelled"
    assert cancelled_entry.result_reason == "Cancelled by user"
    assert lost_entry.result == "failed"
    assert lost_entry.result_reason == "Printer contact lost"


def test_lost_detection_finalizes_bambu_cloud_history(db_session, test_org):
    printer = _make_printer(db_session, test_org.id)
    job = _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="watchdog")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    job.task_created_at = now - timedelta(minutes=20)
    db_session.commit()

    marked = mark_lost_jobs(db_session, now=now)

    assert marked == 1
    db_session.refresh(job)
    assert job.error_code == BambuErrorCode.MQTT_ACK_TIMEOUT.value
    assert job.error_details_json["error_code"] == BambuErrorCode.MQTT_ACK_TIMEOUT.value
    rows = _history_rows(db_session, job)
    assert len(rows) == 1
    assert rows[0].result == "failed"
    assert rows[0].result_reason == to_user_message(BambuErrorCode.MQTT_ACK_TIMEOUT)


def test_print_tracker_still_records_moonraker_history(db_session, test_org, monkeypatch):
    printer = _make_printer(db_session, test_org.id, kind=PrinterKind.snapmaker_u1)
    states = iter([
        {"state": "printing", "filename": "moonraker.gcode"},
        {"state": "operational", "filename": "moonraker.gcode"},
    ])
    monkeypatch.setattr(moonraker, "get_live_status", lambda _url, *, org_id: next(states))
    print_tracker._prev.clear()

    print_tracker._check_org(db_session, test_org)
    print_tracker._check_org(db_session, test_org)

    entry = db_session.query(PrintHistory).filter(PrintHistory.printer_id == printer.id).one()
    assert entry.bambu_cloud_job_id is None
    assert entry.source is None
    assert entry.file_name == "moonraker.gcode"
    assert entry.result == "completed"
    print_tracker._prev.clear()


def test_print_tracker_does_not_create_generic_history_for_active_cloud_job(db_session, test_org, monkeypatch):
    from app.services import bambu

    printer = _make_printer(db_session, test_org.id)
    _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="active")
    monkeypatch.setattr(bambu, "get_cached_state", lambda _dev_id: {"state": "printing", "filename": "cloud.3mf"})
    print_tracker._prev.clear()

    print_tracker._check_org(db_session, test_org)

    assert db_session.query(PrintHistory).filter(PrintHistory.printer_id == printer.id).count() == 0
    print_tracker._prev.clear()
