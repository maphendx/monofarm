"""Moonraker jobs on the unified dispatch pipeline (Pass 2).

Covers the web-process dispatcher (queued → validating → uploading → printing,
failure → failed/retryable) and print_tracker's correlation that closes the job
from observed printer state. Network is never touched — the transport function
and Moonraker polling are monkeypatched.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

from app.core import db as core_db
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.gcode_file import GcodeFile
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.services import (
    agent_print_dispatch,
    bambu_dispatch,
    moonraker,
    moonraker_dispatch,
    print_tracker,
    storage,
)
from app.services.bambu_errors import BambuErrorCode
from app.services.storage import LOCAL_DIR


class _SessionContext:
    def __init__(self, session):
        self.session = session

    def __enter__(self):
        return self.session

    def __exit__(self, *_exc):
        return False


def _make_printer(db_session, org_id: int) -> Printer:
    printer = Printer(
        organization_id=org_id,
        name="Moonraker Queue",
        kind=PrinterKind.snapmaker_u1,
        moonraker_url="http://moonraker.local",
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)
    return printer


def _make_gcode_file(db_session, org_id: int) -> tuple[GcodeFile, str]:
    stored_name = f"test-mr-{uuid.uuid4().hex}.gcode"
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    (LOCAL_DIR / stored_name).write_bytes(b"G28\nT0\nG1 E10\n")
    gcode = GcodeFile(
        organization_id=org_id,
        stored_name=stored_name,
        original_name="part.gcode",
        size_bytes=14,
        filament_meta={"types": ["PLA", "PETG"], "used_g": [12.5, 3.2]},
    )
    db_session.add(gcode)
    db_session.commit()
    db_session.refresh(gcode)
    return gcode, stored_name


def _make_moonraker_job(db_session, *, org_id: int, printer_id: int, gcode_file_id: int | None) -> BambuCloudJob:
    return bambu_dispatch.create_cloud_job(
        db_session,
        org_id=org_id,
        printer_id=printer_id,
        printer_bambu_dev_id=None,
        gcode_file_id=gcode_file_id,
        file_name="part.gcode",
        dispatch_mode="moonraker",
        request_payload={"slot_map": {"0": 1, "1": 0}, "timelapse": False},
    )


def test_dispatch_moonraker_job_acknowledges_start_before_live_printing(db_session, test_org, monkeypatch):
    monkeypatch.setattr(core_db, "SessionLocal", lambda: _SessionContext(db_session))
    monkeypatch.setattr(storage, "is_s3", lambda: False)  # file is written to LOCAL_DIR
    printer = _make_printer(db_session, test_org.id)
    gcode, stored_name = _make_gcode_file(db_session, test_org.id)
    job = _make_moonraker_job(db_session, org_id=test_org.id, printer_id=printer.id, gcode_file_id=gcode.id)

    sent: dict = {}
    bridge_calls: list[tuple[int, str]] = []

    def fake_v2_bridge(job_id: int, *, dispatch_kind: str):
        bridge_calls.append((job_id, dispatch_kind))
        return None

    async def fake_send(**kwargs):
        sent.update(kwargs)
        return {"start_requested": True, "upload_state": "started"}

    monkeypatch.setattr(moonraker_dispatch, "send_file_to_moonraker", fake_send)
    monkeypatch.setattr(
        agent_print_dispatch,
        "try_dispatch_job_to_agent",
        fake_v2_bridge,
        raising=False,
    )

    try:
        asyncio.run(moonraker_dispatch.dispatch_moonraker_job(job.id))
    finally:
        (LOCAL_DIR / stored_name).unlink(missing_ok=True)

    fresh = db_session.get(BambuCloudJob, job.id)
    assert fresh.status == BambuCloudJobStatus.acknowledged
    assert fresh.file_sha256 is not None
    assert fresh.file_size == 14
    assert fresh.started_printing_at is None
    assert fresh.last_mqtt_at is not None
    assert sent["moonraker_url"] == "http://moonraker.local"
    assert sent["slot_map"] == {0: 1, 1: 0}
    assert sent["timelapse"] is False
    assert bridge_calls == [(job.id, "moonraker")]

    assert db_session.query(PrintHistory).filter(PrintHistory.bambu_cloud_job_id == job.id).count() == 0


def test_dispatch_moonraker_job_marks_failed_retryable_on_upload_error(db_session, test_org, monkeypatch):
    monkeypatch.setattr(core_db, "SessionLocal", lambda: _SessionContext(db_session))
    monkeypatch.setattr(storage, "is_s3", lambda: False)  # file is written to LOCAL_DIR
    printer = _make_printer(db_session, test_org.id)
    gcode, stored_name = _make_gcode_file(db_session, test_org.id)
    job = _make_moonraker_job(db_session, org_id=test_org.id, printer_id=printer.id, gcode_file_id=gcode.id)

    async def fake_send(**kwargs):
        raise moonraker.MoonrakerError("upload boom")

    monkeypatch.setattr(moonraker_dispatch, "send_file_to_moonraker", fake_send)

    try:
        asyncio.run(moonraker_dispatch.dispatch_moonraker_job(job.id))
    finally:
        (LOCAL_DIR / stored_name).unlink(missing_ok=True)

    fresh = db_session.get(BambuCloudJob, job.id)
    assert fresh.status == BambuCloudJobStatus.failed
    assert fresh.error_code == BambuErrorCode.MOONRAKER_UPLOAD_FAILED.value
    assert fresh.error_details_json["retryable"] is True


def test_dispatch_moonraker_job_fails_fast_without_file(db_session, test_org, monkeypatch):
    monkeypatch.setattr(core_db, "SessionLocal", lambda: _SessionContext(db_session))
    printer = _make_printer(db_session, test_org.id)
    job = _make_moonraker_job(db_session, org_id=test_org.id, printer_id=printer.id, gcode_file_id=None)

    asyncio.run(moonraker_dispatch.dispatch_moonraker_job(job.id))

    fresh = db_session.get(BambuCloudJob, job.id)
    assert fresh.status == BambuCloudJobStatus.failed
    assert fresh.error_code == BambuErrorCode.FILE_INVALID.value
    assert fresh.error_details_json["retryable"] is False


def test_print_tracker_finalizes_active_moonraker_job(db_session, test_org, monkeypatch):
    printer = _make_printer(db_session, test_org.id)
    job = _make_moonraker_job(db_session, org_id=test_org.id, printer_id=printer.id, gcode_file_id=None)
    job.status = BambuCloudJobStatus.acknowledged
    db_session.commit()
    started = datetime.now(timezone.utc)
    job.printer_ack_at = started
    job.last_mqtt_at = started
    db_session.commit()

    states = iter([
        {"state": "printing", "filename": "part.gcode", "progress_pct": 40, "eta_minutes": 12},
        {"state": "operational", "filename": "part.gcode", "progress_pct": 100, "eta_minutes": 0},
    ])
    monkeypatch.setattr(moonraker, "get_live_status", lambda _url: next(states))
    monkeypatch.setattr(moonraker, "get_remote_file_meta", lambda _url, _name: {})
    print_tracker._prev.clear()

    print_tracker._check_org(db_session, test_org)
    db_session.refresh(job)
    assert job.status == BambuCloudJobStatus.printing
    assert job.progress_pct == 40
    assert job.eta_minutes == 12
    assert job.last_mqtt_at is not None

    print_tracker._check_org(db_session, test_org)
    db_session.refresh(job)
    assert job.status == BambuCloudJobStatus.completed

    entry = db_session.query(PrintHistory).filter(PrintHistory.bambu_cloud_job_id == job.id).one()
    assert entry.result == "completed"
    assert entry.source == "moonraker"
    assert entry.finished_at is not None
    assert entry.duration_minutes is not None
    print_tracker._prev.clear()


def test_print_tracker_does_not_open_generic_history_while_moonraker_job_active(db_session, test_org, monkeypatch):
    printer = _make_printer(db_session, test_org.id)
    job = _make_moonraker_job(db_session, org_id=test_org.id, printer_id=printer.id, gcode_file_id=None)
    assert job.status == BambuCloudJobStatus.queued

    monkeypatch.setattr(
        moonraker, "get_live_status",
        lambda _url: {"state": "printing", "filename": "part.gcode"},
    )
    print_tracker._prev.clear()

    print_tracker._check_org(db_session, test_org)

    assert (
        db_session.query(PrintHistory)
        .filter(PrintHistory.printer_id == printer.id, PrintHistory.bambu_cloud_job_id.is_(None))
        .count()
        == 0
    )
    print_tracker._prev.clear()
