from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.printer import Printer, PrinterKind
from app.services import bambu
from app.services.bambu_job_state import mark_lost_jobs


class _SessionContext:
    def __init__(self, session):
        self.session = session

    def __enter__(self):
        return self.session

    def __exit__(self, *_exc):
        return False


class _Msg:
    def __init__(self, dev_id: str, payload: dict):
        self.topic = f"device/{dev_id}/report"
        self.payload = json.dumps(payload).encode()


def _make_printer(db_session, org_id: int, *, dev_id: str = "DEV-1") -> Printer:
    printer = Printer(
        organization_id=org_id,
        name="Bambu MQTT",
        kind=PrinterKind.bambu,
        bambu_dev_id=dev_id,
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
    dev_id: str = "DEV-1",
    status: BambuCloudJobStatus = BambuCloudJobStatus.task_created,
    file_name: str = "part.3mf",
    task_id: str | None = "task-1",
) -> BambuCloudJob:
    job = BambuCloudJob(
        organization_id=org_id,
        printer_id=printer_id,
        printer_bambu_dev_id=dev_id,
        file_name=file_name,
        status=status,
        correlation_id=f"corr-{printer_id}-{file_name}-{task_id}",
        idempotency_key=f"idem-{printer_id}-{file_name}-{task_id}",
        bambu_task_id=task_id,
        task_created_at=datetime.now(timezone.utc),
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def test_mqtt_report_transitions_matched_job_to_printing(db_session, test_org, monkeypatch):
    monkeypatch.setattr(bambu, "SessionLocal", lambda: _SessionContext(db_session))
    printer = _make_printer(db_session, test_org.id, dev_id="DEV-MATCH")
    job = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer.id,
        dev_id="DEV-MATCH",
        file_name="plate.3mf",
        task_id="task-123",
    )

    bambu._on_message(
        None,
        None,
        _Msg(
            "DEV-MATCH",
            {
                "print": {
                    "gcode_state": "RUNNING",
                    "task_id": "task-123",
                    "subtask_name": "plate.3mf",
                    "mc_percent": 18,
                    "mc_remaining_time": 42,
                }
            },
        ),
    )

    db_session.refresh(job)
    assert job.status == BambuCloudJobStatus.printing
    assert job.progress_pct == 18
    assert job.eta_minutes == 42
    assert job.last_mqtt_at is not None
    assert job.printer_ack_at is not None
    assert job.started_printing_at is not None


def test_mqtt_ambiguous_report_does_not_update_jobs(db_session, test_org, monkeypatch):
    monkeypatch.setattr(bambu, "SessionLocal", lambda: _SessionContext(db_session))
    printer = _make_printer(db_session, test_org.id, dev_id="DEV-AMBIG")
    job_a = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer.id,
        dev_id="DEV-AMBIG",
        file_name="a.3mf",
        task_id=None,
    )
    job_b = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer.id,
        dev_id="DEV-AMBIG",
        file_name="b.3mf",
        task_id=None,
    )

    bambu._on_message(
        None,
        None,
        _Msg("DEV-AMBIG", {"print": {"gcode_state": "RUNNING", "subtask_name": "unknown.3mf", "mc_percent": 50}}),
    )

    db_session.refresh(job_a)
    db_session.refresh(job_b)
    assert job_a.status == BambuCloudJobStatus.task_created
    assert job_b.status == BambuCloudJobStatus.task_created
    assert job_a.last_mqtt_at is None
    assert job_b.last_mqtt_at is None


def test_bed_cleared_failed_report_stays_idle_and_does_not_fail_job(db_session, test_org, monkeypatch):
    monkeypatch.setattr(bambu, "SessionLocal", lambda: _SessionContext(db_session))
    printer = _make_printer(db_session, test_org.id, dev_id="DEV-CLEARED")
    job = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer.id,
        dev_id="DEV-CLEARED",
        file_name="bad-sd.3mf",
        task_id="task-cleared",
        status=BambuCloudJobStatus.printing,
    )

    bambu.mark_bed_cleared("DEV-CLEARED", "bad-sd.3mf")
    bambu._on_message(
        None,
        None,
        _Msg(
            "DEV-CLEARED",
            {
                "print": {
                    "gcode_state": "FAILED",
                    "task_id": "task-cleared",
                    "subtask_name": "bad-sd.3mf",
                    "mc_percent": 0,
                    "mc_remaining_time": 26,
                    "print_error": 83935248,
                }
            },
        ),
    )

    live = bambu.get_cached_state("DEV-CLEARED")
    db_session.refresh(job)
    assert live["state"] == "idle"
    assert live["raw_state"] == "IDLE"
    assert live["filename"] is None
    assert live["progress_pct"] is None
    assert live["eta_minutes"] is None
    assert live["error_msg"] is None
    assert job.status == BambuCloudJobStatus.printing
    assert job.error_msg is None


def test_lost_detection_marks_unacknowledged_task_created_job(db_session, test_org):
    printer = _make_printer(db_session, test_org.id, dev_id="DEV-LOST")
    job = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer.id,
        dev_id="DEV-LOST",
        file_name="lost.3mf",
        task_id="task-lost",
    )
    now = datetime.now(timezone.utc)
    job.task_created_at = now - timedelta(minutes=20)
    db_session.commit()

    marked = mark_lost_jobs(db_session, now=now)

    db_session.refresh(job)
    assert marked == 1
    assert job.status == BambuCloudJobStatus.lost
    assert "acknowledge" in (job.status_reason or "")
