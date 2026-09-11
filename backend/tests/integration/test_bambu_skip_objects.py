from __future__ import annotations

import io
import zipfile
from contextlib import nullcontext

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.gcode_file import GcodeFile
from app.models.printer import Printer, PrinterKind
from app.services import bambu, storage, tunnel


def _sliced_3mf() -> bytes:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(
            "Metadata/slice_info.config",
            """<config><plate><metadata key="index" value="1"/>
            <object identify_id="155" name="Cube" skipped="false"/>
            <object identify_id="165" name="Cube 2" skipped="false"/>
            </plate></config>""",
        )
    return archive.getvalue()


def test_bambu_skip_objects_reads_current_job_and_sends_native_ids(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
    tmp_path,
):
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu X1C",
        kind=PrinterKind.bambu,
        bambu_dev_id="SKIP-DEV-1",
        bambu_dev_ip="192.168.1.8",
        bambu_access_code="12345678",
        bambu_lan_mode=False,
        is_active=True,
    )
    file = GcodeFile(
        organization_id=test_org.id,
        stored_name="skip-test.gcode.3mf",
        original_name="two-cubes.gcode.3mf",
        size_bytes=123,
    )
    db_session.add_all([printer, file])
    db_session.flush()
    job = BambuCloudJob(
        organization_id=test_org.id,
        printer_id=printer.id,
        gcode_file_id=file.id,
        printer_bambu_dev_id=printer.bambu_dev_id,
        file_name=file.original_name,
        status=BambuCloudJobStatus.printing,
        correlation_id="skip-correlation-1",
        idempotency_key="skip-idempotency-1",
        dispatch_mode="lan",
    )
    db_session.add(job)
    db_session.commit()

    monkeypatch.setattr(
        bambu,
        "get_cached_state",
        lambda _dev_id, *, org_id: {
            "state": "printing",
            "filename": "two-cubes.gcode.3mf",
            "skipped_object_ids": [],
            "last_message_at": "2026-07-20T12:00:00+00:00",
        },
    )
    source_path = tmp_path / "skip-test.gcode.3mf"
    source_path.write_bytes(_sliced_3mf())
    monkeypatch.setattr(storage, "local_path_for", lambda *_args: nullcontext(source_path))
    monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: True)

    async def unexpected_agent_command(*_args, **_kwargs):
        raise AssertionError("cloud-mode printer must not send skip through the LAN agent")

    monkeypatch.setattr(tunnel, "send_bambu_mqtt", unexpected_agent_command)
    sent: list[tuple[str, list[int]]] = []
    monkeypatch.setattr(bambu, "skip_objects", lambda dev_id, ids, *, org_id: sent.append((dev_id, ids)))

    state_response = client.get(
        f"/api/printers/{printer.id}/print/skip-objects",
        headers=auth_headers,
    )
    assert state_response.status_code == 200
    assert state_response.json()["available"] is True
    assert [obj["id"] for obj in state_response.json()["objects"]] == ["155", "165"]

    skip_response = client.post(
        f"/api/printers/{printer.id}/print/skip-objects",
        headers=auth_headers,
        json={"object_ids": ["165"]},
    )
    assert skip_response.status_code == 200
    assert sent == [("SKIP-DEV-1", [165])]


def test_bambu_skip_objects_reconciles_lost_agent_ack(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
    tmp_path,
):
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu A9",
        kind=PrinterKind.bambu,
        bambu_dev_id="SKIP-A9",
        bambu_dev_ip="192.168.1.9",
        bambu_access_code="12345678",
        bambu_lan_mode=True,
        is_active=True,
    )
    file = GcodeFile(
        organization_id=test_org.id,
        stored_name="skip-a9.gcode.3mf",
        original_name="two-cubes.gcode.3mf",
        size_bytes=123,
    )
    db_session.add_all([printer, file])
    db_session.flush()
    db_session.add(
        BambuCloudJob(
            organization_id=test_org.id,
            printer_id=printer.id,
            gcode_file_id=file.id,
            printer_bambu_dev_id=printer.bambu_dev_id,
            file_name=file.original_name,
            status=BambuCloudJobStatus.printing,
            correlation_id="skip-a9-correlation",
            idempotency_key="skip-a9-idempotency",
            dispatch_mode="lan",
        )
    )
    db_session.commit()

    states = iter([
        {
            "state": "printing",
            "filename": file.original_name,
            "skipped_object_ids": [],
            "last_message_at": "2026-07-20T13:52:58+00:00",
        },
        {
            "state": "printing",
            "filename": file.original_name,
            "skipped_object_ids": [165],
            "last_message_at": "2026-07-20T13:53:19+00:00",
        },
    ])
    monkeypatch.setattr(bambu, "get_cached_state", lambda _dev_id, *, org_id: next(states))
    source_path = tmp_path / "skip-a9.gcode.3mf"
    source_path.write_bytes(_sliced_3mf())
    monkeypatch.setattr(storage, "local_path_for", lambda *_args: nullcontext(source_path))
    monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: True)

    async def lose_ack(*_args, **_kwargs):
        raise RuntimeError("Agent BAMBU_MQTT timed out (20.0s)")

    monkeypatch.setattr(tunnel, "send_bambu_mqtt", lose_ack)

    response = client.post(
        f"/api/printers/{printer.id}/print/skip-objects",
        headers=auth_headers,
        json={"object_ids": ["165"]},
    )

    assert response.status_code == 200
    assert response.json()["confirmed"] is True
    assert response.json()["reconciled"] is True


@pytest.mark.parametrize(
    "terminal_status",
    [BambuCloudJobStatus.failed, BambuCloudJobStatus.lost],
)
def test_bambu_skip_objects_keeps_large_monofarm_file_after_delayed_start(
    terminal_status: BambuCloudJobStatus,
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
    tmp_path,
):
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu large file",
        kind=PrinterKind.bambu,
        bambu_dev_id=f"SKIP-LARGE-{terminal_status.value}",
        is_active=True,
    )
    file = GcodeFile(
        organization_id=test_org.id,
        stored_name=f"large-{terminal_status.value}.gcode.3mf",
        original_name="Large Model_PLA_2d4h.gcode.3mf",
        size_bytes=250_000_000,
    )
    db_session.add_all([printer, file])
    db_session.flush()
    db_session.add(
        BambuCloudJob(
            organization_id=test_org.id,
            printer_id=printer.id,
            gcode_file_id=file.id,
            printer_bambu_dev_id=printer.bambu_dev_id,
            file_name=file.original_name,
            status=terminal_status,
            correlation_id=f"skip-large-correlation-{terminal_status.value}",
            idempotency_key=f"skip-large-idempotency-{terminal_status.value}",
            dispatch_mode="lan",
        )
    )
    db_session.commit()

    monkeypatch.setattr(
        bambu,
        "get_cached_state",
        lambda _dev_id, *, org_id: {
            "state": "printing",
            "filename": "Large+Model_PLA_2d4h.gcode.3mf",
            "skipped_object_ids": [],
            "last_message_at": "2026-07-20T13:00:00+00:00",
        },
    )
    source_path = tmp_path / f"large-{terminal_status.value}.gcode.3mf"
    source_path.write_bytes(_sliced_3mf())
    monkeypatch.setattr(storage, "local_path_for", lambda *_args: nullcontext(source_path))

    response = client.get(
        f"/api/printers/{printer.id}/print/skip-objects",
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["available"] is True
    assert [obj["id"] for obj in response.json()["objects"]] == ["155", "165"]
