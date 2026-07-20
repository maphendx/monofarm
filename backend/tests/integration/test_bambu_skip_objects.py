from __future__ import annotations

import io
import zipfile

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
):
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu X1C",
        kind=PrinterKind.bambu,
        bambu_dev_id="SKIP-DEV-1",
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
        lambda _dev_id: {
            "state": "printing",
            "filename": "two-cubes.gcode.3mf",
            "skipped_object_ids": [],
            "last_message_at": "2026-07-20T12:00:00+00:00",
        },
    )
    monkeypatch.setattr(storage, "get_bytes", lambda *_args: _sliced_3mf())
    monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: False)
    sent: list[tuple[str, list[int]]] = []
    monkeypatch.setattr(bambu, "skip_objects", lambda dev_id, ids: sent.append((dev_id, ids)))

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
