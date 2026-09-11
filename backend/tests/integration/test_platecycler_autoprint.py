from __future__ import annotations

import asyncio
from datetime import date

from app.core import db as core_db
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.gcode_file import GcodeFile
from app.models.plan import PlanEntry
from app.models.printer import Printer, PrinterKind
from app.models.task import PrintTask
from app.services import autoprint, bambu, bambu_dispatch, bambu_lan_dispatch
from app.services.autoprint import record_completed_run


class _SessionContext:
    """Lets service code that opens its own `SessionLocal()` reuse the test's
    transactional `db_session` instead of a real, separately-committed one."""

    def __init__(self, session):
        self.session = session

    def __enter__(self):
        return self.session

    def __exit__(self, *_exc):
        return False


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


def test_autoprint_cloud_mode_does_not_require_ip_or_access_code(
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
        bambu_access_code=None,
        autoprint_mode="off",
    )

    response = client.patch(
        f"/api/printers/{printer.id}/autoprint",
        headers=auth_headers,
        json={"enabled": True, "plates_loaded": 2},
    )

    assert response.status_code == 200, response.text
    assert response.json()["autoprint_mode"] == "platecycler"


def test_autoprint_explicit_lan_mode_still_requires_local_credentials(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    printer = _printer(
        db_session,
        test_org.id,
        bambu_lan_mode=True,
        bambu_dev_ip=None,
        bambu_access_code=None,
        autoprint_mode="off",
    )

    response = client.patch(
        f"/api/printers/{printer.id}/autoprint",
        headers=auth_headers,
        json={"enabled": True, "plates_loaded": 2},
    )

    assert response.status_code == 400
    assert "LAN mode" in response.json()["detail"]


def test_autoprint_status_returns_current_copy_and_printer_queue(
    client,
    auth_headers,
    db_session,
    test_org,
    admin_user,
) -> None:
    printer = _printer(
        db_session,
        test_org.id,
        bambu_lan_mode=False,
        autoprint_plates_remaining=4,
    )
    first_task = PrintTask(
        organization_id=test_org.id,
        title="Gear set",
        file_name="gear-set.3mf",
    )
    second_task = PrintTask(
        organization_id=test_org.id,
        title="Hook",
        file_name="hook.3mf",
    )
    db_session.add_all([first_task, second_task])
    db_session.flush()
    first_entry = PlanEntry(
        organization_id=test_org.id,
        plan_date=date.today(),
        printer_id=printer.id,
        task_id=first_task.id,
        runs_total=5,
        runs_completed=1,
        priority=1,
    )
    second_entry = PlanEntry(
        organization_id=test_org.id,
        plan_date=date.today(),
        printer_id=printer.id,
        task_id=second_task.id,
        runs_total=2,
        runs_completed=0,
    )
    db_session.add_all([first_entry, second_entry])
    db_session.flush()
    db_session.add(
        BambuCloudJob(
            organization_id=test_org.id,
            printer_id=printer.id,
            created_by_user_id=admin_user.id,
            printer_bambu_dev_id=printer.bambu_dev_id,
            file_name=first_task.file_name,
            dispatch_mode="cloud",
            status=BambuCloudJobStatus.printing,
            correlation_id="autoprint-status-correlation",
            idempotency_key="autoprint-status-idempotency",
            plan_entry_id=first_entry.id,
            autoprint_run_index=2,
            progress_pct=42,
        )
    )
    db_session.commit()

    response = client.get(
        f"/api/printers/{printer.id}/autoprint/status",
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["enabled"] is True
    assert body["plates_remaining"] == 4
    assert body["active_job_status"] == "printing"
    assert body["active_job_progress_pct"] == 42
    assert [entry["file_name"] for entry in body["entries"]] == ["gear-set.3mf", "hook.3mf"]
    assert body["entries"][0] == {
        "id": first_entry.id,
        "title": "Gear set",
        "file_name": "gear-set.3mf",
        "runs_total": 5,
        "runs_completed": 1,
        "active_run_index": 2,
        "is_active": True,
    }


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


def test_start_next_for_printer_uses_hybrid_lan_dispatch_when_tunnel_available(
    db_session, test_org, monkeypatch
) -> None:
    """A cloud-mode printer (bambu_lan_mode=False) with LAN credentials and an
    active agent tunnel must dispatch through the working agent FTPS + MQTT
    path (bambu_lan_dispatch.dispatch_lan_job), the same hybrid route
    files.py:send_to_printer already uses successfully. Routing it through
    dispatch_cloud_job instead fails in production: Bambu Cloud's own upload
    pipeline does not reliably process PlateCycler's re-zipped 3MF."""
    monkeypatch.setattr(core_db, "SessionLocal", lambda: _SessionContext(db_session))
    monkeypatch.setattr(bambu, "get_cached_state", lambda _dev_id, *, org_id: {"state": "idle"})
    monkeypatch.setattr(bambu_lan_dispatch, "has_agent_tunnel", lambda _org_id: True)

    def _fail_if_called(_job_id):
        raise AssertionError("dispatch_cloud_job must not be used when the agent tunnel is available")

    monkeypatch.setattr(bambu_dispatch, "dispatch_cloud_job", _fail_if_called)

    lan_calls: list[int] = []

    async def fake_dispatch_lan_job(job_id):
        lan_calls.append(job_id)
        return None

    monkeypatch.setattr(bambu_lan_dispatch, "dispatch_lan_job", fake_dispatch_lan_job)

    printer = _printer(db_session, test_org.id, bambu_lan_mode=False)
    gcode = GcodeFile(
        organization_id=test_org.id,
        stored_name="hybrid-source.3mf",
        original_name="part.3mf",
        size_bytes=100,
    )
    task = PrintTask(organization_id=test_org.id, title="Part")
    db_session.add_all([gcode, task])
    db_session.flush()
    task.gcode_file_id = gcode.id
    entry = PlanEntry(
        organization_id=test_org.id,
        plan_date=date.today(),
        printer_id=printer.id,
        task_id=task.id,
        runs_total=1,
    )
    db_session.add(entry)
    db_session.commit()

    asyncio.run(autoprint.start_next_for_printer(printer.id))

    assert lan_calls, "AutoPrint should dispatch via the agent FTPS+MQTT hybrid path"

    job = db_session.query(BambuCloudJob).filter(BambuCloudJob.printer_id == printer.id).one()
    assert job.dispatch_mode == "lan"
    assert job.request_payload_json["start_via"] == "cloud"
