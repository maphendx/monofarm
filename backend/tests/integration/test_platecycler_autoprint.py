from __future__ import annotations

from datetime import date

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.gcode_file import GcodeFile
from app.models.plan import PlanEntry
from app.models.printer import Printer, PrinterKind
from app.models.task import PrintTask
from app.services.autoprint import record_completed_run


def _printer(db, org_id: int, **overrides) -> Printer:
    values = {
        "organization_id": org_id,
        "name": "MC 1",
        "kind": PrinterKind.bambu,
        "bambu_dev_id": "A1MINI-1",
        "bambu_dev_ip": "192.168.1.10",
        "bambu_access_code": "12345678",
        "bambu_model": "A1 mini",
        "bambu_lan_mode": True,
        "autoprint_mode": "platecycler",
        "autoprint_plates_remaining": 3,
    }
    values.update(overrides)
    row = Printer(**values)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_autoprint_settings_are_saved_and_returned(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    printer = _printer(db_session, test_org.id, autoprint_mode="off")

    response = client.patch(
        f"/api/printers/{printer.id}/autoprint",
        headers=auth_headers,
        json={
            "enabled": True,
            "plates_loaded": 6,
            "cooldown_temp_c": 35,
            "delay_seconds": 120,
            "eject_last_plate": False,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["autoprint_mode"] == "platecycler"
    assert body["autoprint_plates_remaining"] == 6
    assert body["autoprint_cooldown_temp_c"] == 35
    assert body["autoprint_delay_seconds"] == 120
    assert body["autoprint_eject_last_plate"] is False


def test_autoprint_rejects_non_a1_mini(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    printer = _printer(
        db_session,
        test_org.id,
        bambu_dev_id="P1S-1",
        bambu_model="P1S",
        autoprint_mode="off",
    )

    response = client.patch(
        f"/api/printers/{printer.id}/autoprint",
        headers=auth_headers,
        json={"enabled": True, "plates_loaded": 4},
    )

    assert response.status_code == 400
    assert "A1 Mini" in response.json()["detail"]


def test_autoprint_allows_cloud_mode_printer(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    printer = _printer(db_session, test_org.id, bambu_lan_mode=False, autoprint_mode="off")

    response = client.patch(
        f"/api/printers/{printer.id}/autoprint",
        headers=auth_headers,
        json={"enabled": True, "plates_loaded": 2},
    )

    assert response.status_code == 200, response.text
    assert response.json()["autoprint_mode"] == "platecycler"


def test_autoprint_still_requires_ip_and_access_code(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    printer = _printer(
        db_session,
        test_org.id,
        bambu_lan_mode=False,
        bambu_dev_ip=None,
        autoprint_mode="off",
    )

    response = client.patch(
        f"/api/printers/{printer.id}/autoprint",
        headers=auth_headers,
        json={"enabled": True, "plates_loaded": 2},
    )

    assert response.status_code == 400
    assert "Access Code" in response.json()["detail"]


def test_record_completed_run_is_idempotent(db_session, test_org, admin_user) -> None:
    printer = _printer(db_session, test_org.id)
    gcode = GcodeFile(
        organization_id=test_org.id,
        stored_name="autoprint-source.3mf",
        original_name="part.3mf",
        size_bytes=100,
        filament_meta={"printer_model": "Bambu Lab A1 mini"},
    )
    task = PrintTask(organization_id=test_org.id, title="Part", gcode_file_id=None)
    db_session.add_all([gcode, task])
    db_session.flush()
    task.gcode_file_id = gcode.id
    entry = PlanEntry(
        organization_id=test_org.id,
        plan_date=date.today(),
        printer_id=printer.id,
        task_id=task.id,
        runs_total=2,
        runs_completed=0,
    )
    db_session.add(entry)
    db_session.flush()
    job = BambuCloudJob(
        organization_id=test_org.id,
        printer_id=printer.id,
        gcode_file_id=gcode.id,
        created_by_user_id=admin_user.id,
        printer_bambu_dev_id=printer.bambu_dev_id,
        file_name=gcode.original_name,
        dispatch_mode="lan",
        status=BambuCloudJobStatus.completed,
        correlation_id="autoprint-correlation",
        idempotency_key="autoprint-idempotency",
        plan_entry_id=entry.id,
        autoprint_run_index=1,
    )
    db_session.add(job)
    db_session.commit()

    assert record_completed_run(db_session, job) is True
    assert entry.runs_completed == 1
    assert entry.done is False
    assert printer.autoprint_plates_remaining == 2

    assert record_completed_run(db_session, job) is False
    assert entry.runs_completed == 1
    assert printer.autoprint_plates_remaining == 2


def _plan_entry(db, org_id: int, printer_id: int, runs_total: int = 1) -> PlanEntry:
    task = PrintTask(organization_id=org_id, title="Part")
    db.add(task)
    db.flush()
    entry = PlanEntry(
        organization_id=org_id,
        plan_date=date.today(),
        printer_id=printer_id,
        task_id=task.id,
        runs_total=runs_total,
    )
    db.add(entry)
    db.commit()
    return entry


def test_advance_queue_counts_runs_before_marking_done(db_session, test_org) -> None:
    from datetime import datetime, timezone

    from app.services.print_tracker import _advance_queue

    printer = _printer(db_session, test_org.id, autoprint_mode="off")
    entry = _plan_entry(db_session, test_org.id, printer.id, runs_total=3)

    now = datetime.now(timezone.utc)
    _advance_queue(db_session, printer, now)
    assert entry.runs_completed == 1
    assert entry.done is False

    _advance_queue(db_session, printer, now)
    _advance_queue(db_session, printer, now)
    assert entry.runs_completed == 3
    assert entry.done is True


def test_advance_queue_skips_platecycler_printers(db_session, test_org) -> None:
    from datetime import datetime, timezone

    from app.services.print_tracker import _advance_queue

    printer = _printer(db_session, test_org.id)  # autoprint_mode="platecycler"
    entry = _plan_entry(db_session, test_org.id, printer.id, runs_total=2)

    _advance_queue(db_session, printer, datetime.now(timezone.utc))
    assert entry.runs_completed == 0
    assert entry.done is False
