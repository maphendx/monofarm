from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.organization import BambuAuthType
from app.models.printer import Printer, PrinterKind
from app.services import bambu, bambu_dispatch
from app.services.bambu_errors import BambuErrorCode
from app.services.bambu_job_state import transition_job


def _make_bambu_printer(db_session, org_id: int, *, dev_id: str, name: str = "Bambu Health") -> Printer:
    printer = Printer(
        organization_id=org_id,
        name=name,
        kind=PrinterKind.bambu,
        bambu_dev_id=dev_id,
        bambu_lan_mode=False,
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
    dev_id: str,
    status: BambuCloudJobStatus,
    suffix: str,
    created_at: datetime | None = None,
) -> BambuCloudJob:
    job = BambuCloudJob(
        organization_id=org_id,
        printer_id=printer_id,
        printer_bambu_dev_id=dev_id,
        file_name=f"{suffix}.3mf",
        status=status,
        correlation_id=f"obs-corr-{suffix}",
        idempotency_key=f"obs-idem-{suffix}",
        created_at=created_at or datetime.now(timezone.utc),
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def test_bambu_observability_emits_structured_job_events(db_session, test_org, caplog):
    printer = _make_bambu_printer(db_session, test_org.id, dev_id="OBS-LOG")
    caplog.set_level(logging.INFO)

    job = bambu_dispatch.create_cloud_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer.id,
        printer_bambu_dev_id="OBS-LOG",
        gcode_file_id=None,
        file_name="observed.3mf",
        region="us",
    )
    job.status = BambuCloudJobStatus.printing
    db_session.flush()
    transition_job(job, BambuCloudJobStatus.completed, now=datetime.now(timezone.utc))
    db_session.commit()

    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "bambu.cloud.job.created" in messages
    assert f"job_id={job.id}" in messages
    assert "bambu.cloud.job.completed" in messages
    assert "correlation_id=" in messages


def test_bambu_observability_failed_event_includes_error_code(db_session, test_org, caplog):
    printer = _make_bambu_printer(db_session, test_org.id, dev_id="OBS-FAIL")
    job = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer.id,
        dev_id="OBS-FAIL",
        status=BambuCloudJobStatus.task_created,
        suffix="failed-log",
    )
    caplog.set_level(logging.INFO)

    transition_job(
        job,
        BambuCloudJobStatus.failed,
        reason="Task create failed",
        error_code=BambuErrorCode.TASK_CREATE_FAILED.value,
    )
    db_session.commit()

    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "bambu.cloud.job.failed" in messages
    assert "error_code=TASK_CREATE_FAILED" in messages


def test_bambu_health_endpoint_reports_no_auth(client, auth_headers):
    resp = client.get("/api/orgs/me/bambu-health", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["auth"]["configured"] is False
    assert body["auth"]["reauth_required"] is False
    assert body["mqtt"]["connected"] is False
    assert body["printers"] == {"total": 0, "bambu_cloud": 0, "online": 0, "offline": 0}
    assert body["jobs"]["active"] == 0
    assert body["jobs"]["recent_failures"] == 0


def test_bambu_health_endpoint_reports_auth_printers_and_jobs(client, auth_headers, db_session, test_org):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    test_org.bambu_access_token = "encrypted-token"
    test_org.bambu_auth_type = BambuAuthType.email_code
    test_org.bambu_region = "us"
    test_org.bambu_reauth_required = True
    test_org.bambu_last_auth_success_at = now - timedelta(minutes=3)
    test_org.bambu_last_auth_error = "Manual reauth required"
    db_session.commit()

    printer_online = _make_bambu_printer(db_session, test_org.id, dev_id="OBS-ONLINE", name="Online")
    _make_bambu_printer(db_session, test_org.id, dev_id="OBS-OFFLINE", name="Offline")
    db_session.add(Printer(organization_id=test_org.id, name="Moonraker", kind=PrinterKind.snapmaker_u1, is_active=True))
    active = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer_online.id,
        dev_id="OBS-ONLINE",
        status=BambuCloudJobStatus.queued,
        suffix="active",
    )
    stuck = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer_online.id,
        dev_id="OBS-ONLINE",
        status=BambuCloudJobStatus.task_created,
        suffix="stuck",
    )
    stuck.task_created_at = now - timedelta(minutes=20)
    failed = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer_online.id,
        dev_id="OBS-ONLINE",
        status=BambuCloudJobStatus.failed,
        suffix="failed",
    )
    failed.failed_at = now - timedelta(hours=2)
    lost = _make_job(
        db_session,
        org_id=test_org.id,
        printer_id=printer_online.id,
        dev_id="OBS-ONLINE",
        status=BambuCloudJobStatus.lost,
        suffix="lost",
    )
    db_session.commit()

    bambu._mqtt_clients[test_org.id] = object()
    bambu._dev_to_org["OBS-ONLINE"] = test_org.id
    bambu._dev_to_org["OBS-OFFLINE"] = test_org.id
    bambu._state_cache["OBS-ONLINE"] = {
        "ts": time.monotonic(),
        "state": "printing",
        "last_message_at": now.isoformat(),
    }
    bambu._state_cache["OBS-OFFLINE"] = {"ts": time.monotonic(), "state": "offline"}
    try:
        resp = client.get("/api/orgs/me/bambu-health", headers=auth_headers)
    finally:
        bambu._mqtt_clients.pop(test_org.id, None)
        bambu._dev_to_org.pop("OBS-ONLINE", None)
        bambu._dev_to_org.pop("OBS-OFFLINE", None)
        bambu._state_cache.pop("OBS-ONLINE", None)
        bambu._state_cache.pop("OBS-OFFLINE", None)

    assert resp.status_code == 200
    body = resp.json()
    assert body["auth"]["configured"] is True
    assert body["auth"]["auth_type"] == "email_code"
    assert body["auth"]["reauth_required"] is True
    assert body["auth"]["last_error"] == "Manual reauth required"
    assert body["auth"]["region"] == "us"
    assert body["mqtt"]["connected"] is True
    assert body["mqtt"]["last_message_at"] == now.isoformat().replace("+00:00", "Z")
    assert body["mqtt"]["tracked_devices"] == ["OBS-OFFLINE", "OBS-ONLINE"]
    assert body["printers"] == {"total": 3, "bambu_cloud": 2, "online": 1, "offline": 1}
    assert body["jobs"]["queued"] == 1
    assert body["jobs"]["active"] == 2
    assert body["jobs"]["stuck_or_lost"] == 2
    assert body["jobs"]["recent_failures"] == 1

    assert active.id
    assert lost.id
