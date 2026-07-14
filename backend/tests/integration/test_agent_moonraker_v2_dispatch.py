from __future__ import annotations

import hashlib
import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
from io import BytesIO
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.core import db as core_db
from app.models.agent import AgentCommand, AgentDevice, AgentEvent
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.gcode_file import GcodeFile
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.services import agent_print_dispatch, moonraker_dispatch


class _SessionContext:
    def __init__(self, session: Session) -> None:
        self.session = session

    def __enter__(self) -> Session:
        return self.session

    def __exit__(self, *_exc: object) -> bool:
        return False


class _GuardedReader(BytesIO):
    def read(self, size: int = -1) -> bytes:
        assert 0 < size <= agent_print_dispatch.FILE_HASH_CHUNK_SIZE
        return super().read(size)


class _GuardedPath:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.open_count = 0

    def open(self, mode: str) -> _GuardedReader:
        assert mode == "rb"
        self.open_count += 1
        return _GuardedReader(self.data)


def _device(db: Session, org: Organization) -> AgentDevice:
    device = AgentDevice(
        organization_id=org.id,
        name=f"Moonraker Agent {uuid4().hex[:8]}",
        scopes=list(agent_print_dispatch.REQUIRED_AGENT_SCOPES),
        capabilities=list(agent_print_dispatch.REQUIRED_AGENT_CAPABILITIES),
        credential_hash=hashlib.sha256(uuid4().bytes).hexdigest(),
        paired_at=datetime.now(timezone.utc),
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def _job(
    db: Session,
    org: Organization,
    *,
    data: bytes,
    request_payload: dict | None = None,
    kind: PrinterKind = PrinterKind.other,
    filament_meta: dict | None = None,
) -> tuple[Printer, GcodeFile, BambuCloudJob]:
    suffix = uuid4().hex[:8]
    printer = Printer(
        organization_id=org.id,
        name=f"Moonraker {suffix}",
        kind=kind,
        moonraker_url="http://192.168.50.40:7125",
        is_active=True,
    )
    gcode = GcodeFile(
        organization_id=org.id,
        stored_name=f"{uuid4().hex}.gcode",
        original_name=f"part-{suffix}.gcode",
        size_bytes=len(data),
        filament_meta=filament_meta or {"types": ["PLA"], "used_g": [4.2]},
    )
    db.add_all([printer, gcode])
    db.flush()
    job = BambuCloudJob(
        organization_id=org.id,
        printer_id=printer.id,
        gcode_file_id=gcode.id,
        file_name=gcode.original_name,
        file_size=len(data),
        dispatch_mode="moonraker",
        status=BambuCloudJobStatus.queued,
        correlation_id=uuid4().hex,
        idempotency_key=f"moonraker-v2-{suffix}-{uuid4().hex}",
        request_payload_json=request_payload or {"slot_map": {"0": 0}},
    )
    db.add(job)
    db.commit()
    db.refresh(printer)
    db.refresh(gcode)
    db.refresh(job)
    return printer, gcode, job


def _event(
    db: Session,
    command: AgentCommand,
    *,
    event_type: str,
    payload: dict,
    sequence: int,
) -> AgentEvent:
    event = AgentEvent(
        organization_id=command.organization_id,
        agent_device_id=command.agent_device_id,
        printer_id=command.printer_id,
        command_id=command.id,
        event_stream_id=command.agent_device_id,
        monotonic_sequence=sequence,
        event_type=event_type,
        payload_json=payload,
        occurred_at_device=datetime.now(timezone.utc),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


def _success(payload: dict) -> dict:
    return {"payload": payload, "_ack_states": ["delivered", "terminal"]}


def _try_dispatch(
    db: Session,
    job: BambuCloudJob,
    data: bytes,
) -> tuple[agent_print_dispatch.AgentPrintDispatchResult | None, _GuardedPath]:
    guarded = _GuardedPath(data)

    @contextmanager
    def source_path_factory(_stored_name: str, _organization_id: int):
        yield guarded

    result = agent_print_dispatch.try_dispatch_job_to_agent(
        job.id,
        dispatch_kind="moonraker",
        session_factory=lambda: _SessionContext(db),
        source_path_factory=source_path_factory,
        presigned_url_factory=lambda *_args, **_kwargs: (
            "https://artifacts.monofarm.test/part.gcode?signature=secret"
        ),
    )
    return result, guarded


def _upload_result(gcode: GcodeFile, data: bytes) -> dict:
    return {
        "provider": "moonraker",
        "remote_id": gcode.original_name,
        "file_name": gcode.original_name,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def test_standard_moonraker_job_runs_durable_upload_then_start(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    data = b"G28\nG1 X10 Y10\n"
    device = _device(db_session, test_org)
    _printer, gcode, job = _job(db_session, test_org, data=data)
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, guarded = _try_dispatch(db_session, job, data)

    assert dispatched is not None
    assert guarded.open_count == 1
    assert dispatched.command.payload_json["file_name"] == gcode.original_name
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.uploading

    upload_result = _upload_result(gcode, data)
    upload_event = _event(
        db_session,
        dispatched.command,
        event_type="command.succeeded",
        payload=_success(upload_result),
        sequence=1,
    )
    upload_outcome = agent_print_dispatch.process_agent_print_event(
        db_session,
        upload_event,
    )
    start = (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:start")
        .one()
    )

    assert upload_outcome.action == "start_created"
    assert start.payload_json == {
        "remote_id": gcode.original_name,
        "file_name": gcode.original_name,
    }
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.uploading

    start_event = _event(
        db_session,
        start,
        event_type="command.succeeded",
        payload=_success(
            {
                "provider": "moonraker",
                "remote_id": gcode.original_name,
                "printer_reference": gcode.original_name,
            }
        ),
        sequence=2,
    )
    start_outcome = agent_print_dispatch.process_agent_print_event(
        db_session,
        start_event,
    )

    assert start_outcome.action == "printer_ack_confirmed"
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.acknowledged
    assert job.printer_ack_at is not None
    assert job.started_printing_at is None
    assert job.bambu_task_id is None


@pytest.mark.parametrize(
    ("request_payload", "kind", "filament_meta"),
    [
        ({"slot_map": {"0": 1}}, PrinterKind.other, None),
        ({"slot_map": {"0": 0}, "auto_bed_leveling": False}, PrinterKind.other, None),
        ({"slot_map": {"0": 0}, "timelapse": False}, PrinterKind.other, None),
        ({"slot_map": {"0": 0}, "ai_detection": False}, PrinterKind.other, None),
        ({"slot_map": {"0": 0}, "calibrate_slots": []}, PrinterKind.other, None),
        ({"slot_map": {"0": 0}}, PrinterKind.snapmaker_u1, None),
        (
            {"slot_map": {"0": 0, "1": 1}},
            PrinterKind.other,
            {"types": ["PLA", "PETG"], "used_g": [4.2, 0]},
        ),
    ],
    ids=[
        "non_identity_remap",
        "bed_level_override",
        "timelapse_override",
        "ai_override",
        "calibrate_override",
        "u1_mapping_script",
        "derived_used_slot_filter",
    ],
)
def test_transformed_moonraker_jobs_fall_back_before_file_read_or_state_mutation(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
    request_payload: dict,
    kind: PrinterKind,
    filament_meta: dict | None,
) -> None:
    data = b"G28\nT0\n"
    device = _device(db_session, test_org)
    _printer, _gcode, job = _job(
        db_session,
        test_org,
        data=data,
        request_payload=request_payload,
        kind=kind,
        filament_meta=filament_meta,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )

    result, guarded = _try_dispatch(db_session, job, data)

    assert result is None
    assert guarded.open_count == 0
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.queued
    assert (
        db_session.query(AgentCommand)
        .filter(AgentCommand.organization_id == test_org.id)
        .count()
        == 0
    )


def test_moonraker_bridge_requires_connected_device_printer_assignment(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    data = b"G28\n"
    assigned_device = _device(db_session, test_org)
    assigned_device.site_id = "site-a"
    connected_wrong_device = _device(db_session, test_org)
    connected_wrong_device.site_id = "site-b"
    printer, _gcode, job = _job(db_session, test_org, data=data)
    printer.agent_device_id = assigned_device.id
    db_session.commit()
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: connected_wrong_device.id,
    )

    rejected, guarded = _try_dispatch(db_session, job, data)

    assert rejected is None
    assert guarded.open_count == 0
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.queued

    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: assigned_device.id,
    )
    accepted, guarded = _try_dispatch(db_session, job, data)

    assert accepted is not None
    assert guarded.open_count == 1


@pytest.mark.parametrize(
    "result_patch",
    [
        {"provider": "bambu"},
        {"remote_id": "different.gcode"},
        {"file_name": "different.gcode"},
    ],
)
def test_moonraker_upload_result_requires_provider_and_exact_filename(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
    result_patch: dict,
) -> None:
    data = b"G28\n"
    device = _device(db_session, test_org)
    _printer, gcode, job = _job(db_session, test_org, data=data)
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, _guarded = _try_dispatch(db_session, job, data)
    assert dispatched is not None
    result = {**_upload_result(gcode, data), **result_patch}
    event = _event(
        db_session,
        dispatched.command,
        event_type="command.succeeded",
        payload=_success(result),
        sequence=1,
    )

    with pytest.raises(agent_print_dispatch.AgentPrintDispatchError):
        agent_print_dispatch.process_agent_print_event(db_session, event)

    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.uploading
    assert (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:start")
        .count()
        == 0
    )


def test_moonraker_ambiguous_start_reconciles_without_replaying_start(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    data = b"G28\n"
    device = _device(db_session, test_org)
    _printer, gcode, job = _job(db_session, test_org, data=data)
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, _guarded = _try_dispatch(db_session, job, data)
    assert dispatched is not None
    upload = _event(
        db_session,
        dispatched.command,
        event_type="command.succeeded",
        payload=_success(_upload_result(gcode, data)),
        sequence=1,
    )
    agent_print_dispatch.process_agent_print_event(db_session, upload)
    start = (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:start")
        .one()
    )
    ambiguous = _event(
        db_session,
        start,
        event_type="command.needs_reconcile",
        payload={"error": "Moonraker start ACK lost"},
        sequence=2,
    )

    first = agent_print_dispatch.process_agent_print_event(db_session, ambiguous)
    replay = agent_print_dispatch.process_agent_print_event(db_session, ambiguous)
    reconcile = (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:reconcile")
        .one()
    )

    assert first.action == "reconcile_created"
    assert replay.action == "reconcile_replayed"
    assert reconcile.payload_json == start.payload_json
    assert (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:start")
        .count()
        == 1
    )

    reconciled = _event(
        db_session,
        reconcile,
        event_type="command.succeeded",
        payload=_success(
            {
                "provider": "moonraker",
                "remote_id": gcode.original_name,
                "state": "printing",
                "printer_reference": gcode.original_name,
            }
        ),
        sequence=3,
    )
    outcome = agent_print_dispatch.process_agent_print_event(db_session, reconciled)

    assert outcome.action == "printer_ack_confirmed"
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.acknowledged


@pytest.mark.parametrize(
    ("failed_stage", "expected_error_code"),
    [
        ("upload", "MOONRAKER_UPLOAD_FAILED"),
        ("start", "MOONRAKER_START_FAILED"),
    ],
)
def test_failed_moonraker_stage_uses_moonraker_error_taxonomy(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
    failed_stage: str,
    expected_error_code: str,
) -> None:
    data = b"G28\n"
    device = _device(db_session, test_org)
    _printer, gcode, job = _job(db_session, test_org, data=data)
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, _guarded = _try_dispatch(db_session, job, data)
    assert dispatched is not None
    command = dispatched.command
    sequence = 1
    if failed_stage == "start":
        uploaded = _event(
            db_session,
            command,
            event_type="command.succeeded",
            payload=_success(_upload_result(gcode, data)),
            sequence=sequence,
        )
        agent_print_dispatch.process_agent_print_event(db_session, uploaded)
        command = (
            db_session.query(AgentCommand)
            .filter_by(idempotency_key=f"agent-job:{job.id}:start")
            .one()
        )
        sequence += 1
    failed = _event(
        db_session,
        command,
        event_type="command.failed",
        payload={"error": "printer unavailable"},
        sequence=sequence,
    )

    agent_print_dispatch.process_agent_print_event(db_session, failed)

    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.failed
    assert job.error_code == expected_error_code
    assert job.error_details_json["retryable"] is True


def test_real_moonraker_dispatch_prefers_durable_bridge_over_legacy_transport(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    data = b"G28\n"
    _printer, _gcode, job = _job(db_session, test_org, data=data)
    monkeypatch.setattr(core_db, "SessionLocal", lambda: _SessionContext(db_session))
    calls: list[tuple[int, str]] = []

    def fake_bridge(job_id: int, *, dispatch_kind: str):
        calls.append((job_id, dispatch_kind))
        return object()

    async def forbidden_legacy(*_args, **_kwargs):
        raise AssertionError("legacy Moonraker transport ran after durable claim")

    monkeypatch.setattr(
        agent_print_dispatch,
        "try_dispatch_job_to_agent",
        fake_bridge,
    )
    monkeypatch.setattr(
        moonraker_dispatch,
        "send_file_to_moonraker",
        forbidden_legacy,
    )

    result = asyncio.run(moonraker_dispatch.dispatch_moonraker_job(job.id))

    assert calls == [(job.id, "moonraker")]
    assert result is not None
    assert result.id == job.id
