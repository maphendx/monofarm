from __future__ import annotations

import asyncio
import hashlib
from contextlib import contextmanager
from datetime import datetime, timezone
from io import BytesIO
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.models.agent import AgentCommand, AgentDevice, AgentEvent
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.gcode_file import GcodeFile
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.schemas.agent import AgentEventIngestItem
from app.core import db as core_db
from app.services import agent_print_dispatch, bambu_lan_dispatch, storage
from app.services.agent_commands import ingest_agent_events


REQUIRED_SCOPES = ["agent:connect", "commands:read", "events:write", "status:write"]
REQUIRED_CAPABILITIES = ["durable_commands_v2", "provider_adapters_v2"]


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


class _SessionContext:
    def __init__(self, session: Session) -> None:
        self.session = session

    def __enter__(self) -> Session:
        return self.session

    def __exit__(self, *_exc: object) -> bool:
        return False


def _device(
    db: Session,
    org: Organization,
    *,
    name: str,
    scopes: list[str] | None = None,
    capabilities: list[str] | None = None,
) -> AgentDevice:
    device = AgentDevice(
        organization_id=org.id,
        name=name,
        scopes=scopes if scopes is not None else REQUIRED_SCOPES,
        capabilities=capabilities if capabilities is not None else REQUIRED_CAPABILITIES,
        credential_hash=hashlib.sha256(name.encode()).hexdigest(),
        paired_at=datetime.now(timezone.utc),
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def _bambu_job(
    db: Session,
    org: Organization,
    *,
    suffix: str,
    data: bytes,
) -> tuple[Printer, GcodeFile, BambuCloudJob]:
    printer = Printer(
        organization_id=org.id,
        name=f"A1 Mini {suffix}",
        kind=PrinterKind.bambu,
        bambu_lan_mode=True,
        bambu_dev_id=f"DEV-{suffix}",
        bambu_dev_ip="192.168.50.20",
        bambu_access_code="12345678",
        bambu_model="N1",
        is_active=True,
    )
    gcode = GcodeFile(
        organization_id=org.id,
        stored_name=f"{uuid4().hex}.3mf",
        original_name=f"plate-{suffix}.gcode.3mf",
        size_bytes=len(data),
        filament_meta={"bambu_plate_gcode": "Metadata/plate_2.gcode"},
    )
    db.add_all([printer, gcode])
    db.flush()
    job = BambuCloudJob(
        organization_id=org.id,
        printer_id=printer.id,
        gcode_file_id=gcode.id,
        printer_bambu_dev_id=printer.bambu_dev_id,
        file_name=gcode.original_name,
        file_size=len(data),
        dispatch_mode="lan",
        status=BambuCloudJobStatus.queued,
        correlation_id=uuid4().hex,
        idempotency_key=f"test-agent-job-{suffix}-{uuid4().hex}",
        request_payload_json={
            "ams_mapping": [0, 1],
            "use_ams": True,
            "auto_bed_leveling": False,
            "flow_calibration": True,
        },
    )
    db.add(job)
    db.commit()
    db.refresh(printer)
    db.refresh(gcode)
    db.refresh(job)
    return printer, gcode, job


def _dispatch(
    db: Session,
    job: BambuCloudJob,
    data: bytes,
    *,
    source_path: _GuardedPath | None = None,
) -> tuple[agent_print_dispatch.AgentPrintDispatchResult, _GuardedPath]:
    guarded_path = source_path or _GuardedPath(data)

    @contextmanager
    def source_path_factory(_stored_name: str, _org_id: int):
        yield guarded_path

    result = agent_print_dispatch.dispatch_job_to_agent(
        db,
        job_id=job.id,
        source_path_factory=source_path_factory,
        presigned_url_factory=lambda _stored_name, _org_id, **_kwargs: (
            "https://artifacts.monofarm.test/object.3mf?signature=secret"
        ),
    )
    return result, guarded_path


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


def _succeeded_payload(payload: dict) -> dict:
    return {"payload": payload, "_ack_states": ["delivered", "terminal"]}


def test_eligibility_uses_the_exact_connected_v2_device_and_fails_closed(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    disconnected_eligible = _device(db_session, test_org, name="Eligible but offline")
    connected_incomplete = _device(
        db_session,
        test_org,
        name="Connected without provider adapter",
        capabilities=["durable_commands_v2"],
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda organization_id: (
            connected_incomplete.id if organization_id == test_org.id else None
        ),
    )

    ineligible = agent_print_dispatch.agent_print_dispatch_eligibility(
        db_session,
        organization_id=test_org.id,
    )

    assert ineligible.eligible is False
    assert ineligible.device_id == connected_incomplete.id
    assert ineligible.reason == "missing_capability:provider_adapters_v2"
    assert ineligible.device_id != disconnected_eligible.id

    connected_incomplete.capabilities = REQUIRED_CAPABILITIES
    connected_incomplete.scopes = ["agent:connect", "commands:read", "events:write"]
    db_session.commit()
    missing_scope = agent_print_dispatch.agent_print_dispatch_eligibility(
        db_session,
        organization_id=test_org.id,
    )
    assert missing_scope.eligible is False
    assert missing_scope.reason == "missing_scope:status:write"

    connected_incomplete.scopes = REQUIRED_SCOPES
    connected_incomplete.site_id = "main-site"
    db_session.commit()
    missing_site_assignment = agent_print_dispatch.agent_print_dispatch_eligibility(
        db_session,
        organization_id=test_org.id,
    )
    assert missing_site_assignment.eligible is False
    assert missing_site_assignment.reason == "printer_site_assignment_unavailable"

    connected_incomplete.site_id = None
    db_session.commit()
    eligible = agent_print_dispatch.agent_print_dispatch_eligibility(
        db_session,
        organization_id=test_org.id,
    )
    assert eligible.eligible is True
    assert eligible.device_id == connected_incomplete.id
    assert eligible.reason is None


def test_dispatch_hashes_in_bounded_chunks_and_creates_one_strict_upload_command(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"3MF" * 100_000
    device = _device(db_session, test_org, name="Dispatch Agent")
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix="bounded",
        data=data,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )

    first, guarded_path = _dispatch(db_session, job, data)
    replay, _ = _dispatch(db_session, job, data, source_path=guarded_path)

    assert first.created is True
    assert replay.created is False
    assert replay.command.id == first.command.id
    assert guarded_path.open_count == 1
    assert first.command.command_type == "printer.upload"
    assert first.command.idempotency_key == f"agent-job:{job.id}:upload"
    assert first.command.agent_device_id == device.id
    assert first.command.payload_json == {
        "source_url": "https://artifacts.monofarm.test/object.3mf?signature=secret",
        "file_name": "plate-bounded.gcode.3mf",
        "expected_size": len(data),
        "expected_sha256": hashlib.sha256(data).hexdigest(),
        "expires_at": first.command.payload_json["expires_at"],
    }
    assert first.command.payload_json["expires_at"].endswith("+00:00")
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.uploading
    assert job.file_size == len(data)
    assert job.file_sha256 == hashlib.sha256(data).hexdigest()


def test_try_dispatch_bridge_claims_eligible_bambu_lan_job(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"production-caller-3mf"
    device = _device(db_session, test_org, name="Production Caller Agent")
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix="production-caller",
        data=data,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    guarded_path = _GuardedPath(data)

    @contextmanager
    def source_path_factory(_stored_name: str, _org_id: int):
        yield guarded_path

    result = agent_print_dispatch.try_dispatch_job_to_agent(
        job.id,
        dispatch_kind="bambu_lan",
        session_factory=lambda: _SessionContext(db_session),
        source_path_factory=source_path_factory,
        presigned_url_factory=lambda *_args, **_kwargs: (
            "https://artifacts.monofarm.test/object.3mf?signature=secret"
        ),
    )

    assert result is not None
    assert result.job_id == job.id
    assert guarded_path.open_count == 1
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.uploading
    assert (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:upload")
        .count()
        == 1
    )


def test_unknown_dispatch_kind_falls_back_before_bridge_database_lookup() -> None:
    def forbidden_session():
        raise AssertionError("Unknown dispatch kind must not enter the v2 bridge")

    result = agent_print_dispatch.try_dispatch_job_to_agent(
        123,
        dispatch_kind="octoprint",
        session_factory=forbidden_session,
    )

    assert result is None


@pytest.mark.parametrize("ineligible_variant", ["hybrid", "platecycler", "lan_disabled"])
def test_bambu_variants_fall_back_before_artifact_read_or_job_mutation(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
    ineligible_variant: str,
) -> None:
    data = b"legacy-only-artifact"
    device = _device(db_session, test_org, name=f"Fallback {ineligible_variant}")
    printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix=f"fallback-{ineligible_variant}",
        data=data,
    )
    if ineligible_variant == "hybrid":
        job.request_payload_json = {**job.request_payload_json, "start_via": "cloud"}
    elif ineligible_variant == "platecycler":
        job.request_payload_json = {**job.request_payload_json, "platecycler": {}}
    else:
        printer.bambu_lan_mode = False
    db_session.commit()
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    guarded_path = _GuardedPath(data)

    @contextmanager
    def source_path_factory(_stored_name: str, _org_id: int):
        yield guarded_path

    result = agent_print_dispatch.try_dispatch_job_to_agent(
        job.id,
        dispatch_kind="bambu_lan",
        session_factory=lambda: _SessionContext(db_session),
        source_path_factory=source_path_factory,
        presigned_url_factory=lambda *_args, **_kwargs: (
            "https://artifacts.monofarm.test/object.3mf?signature=secret"
        ),
    )

    assert result is None
    assert guarded_path.open_count == 0
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.queued
    assert db_session.query(AgentCommand).filter_by(organization_id=test_org.id).count() == 0


def test_real_bambu_dispatch_prefers_v2_bridge_without_running_legacy_transport(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"v2-first"
    _printer, _gcode, job = _bambu_job(db_session, test_org, suffix="v2-first", data=data)
    monkeypatch.setattr(core_db, "SessionLocal", lambda: _SessionContext(db_session))
    calls: list[int] = []

    def fake_v2_bridge(job_id: int, *, dispatch_kind: str):
        calls.append(job_id)
        assert dispatch_kind == "bambu_lan"
        return object()

    async def forbidden_upload(*_args, **_kwargs):
        raise AssertionError("legacy Bambu upload must not run after v2 claimed the job")

    monkeypatch.setattr(
        agent_print_dispatch,
        "try_dispatch_job_to_agent",
        fake_v2_bridge,
        raising=False,
    )
    monkeypatch.setattr(bambu_lan_dispatch._tunnel, "send_bambu_upload", forbidden_upload)

    result = asyncio.run(bambu_lan_dispatch.dispatch_lan_job(job.id))

    assert calls == [job.id]
    assert result is not None
    assert result.id == job.id


def test_real_bambu_dispatch_preserves_legacy_fallback_when_v2_is_ineligible(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"legacy-fallback"
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix="legacy-fallback",
        data=data,
    )
    monkeypatch.setattr(core_db, "SessionLocal", lambda: _SessionContext(db_session))
    monkeypatch.setattr(
        agent_print_dispatch,
        "try_dispatch_job_to_agent",
        lambda _job_id, *, dispatch_kind: None,
        raising=False,
    )
    monkeypatch.setattr(bambu_lan_dispatch._tunnel, "has_tunnel", lambda _org_id: True)
    monkeypatch.setattr(
        storage,
        "presigned_url",
        lambda *_args, **_kwargs: "https://artifacts.monofarm.test/legacy.3mf",
    )
    calls: list[str] = []

    async def fake_upload(*_args, **_kwargs) -> str:
        calls.append("upload")
        return "sdcard/legacy-fallback.3mf"

    async def fake_mqtt(*_args, **_kwargs) -> None:
        calls.append("start")

    monkeypatch.setattr(bambu_lan_dispatch._tunnel, "send_bambu_upload", fake_upload)
    monkeypatch.setattr(bambu_lan_dispatch._tunnel, "send_bambu_mqtt", fake_mqtt)

    result = asyncio.run(bambu_lan_dispatch.dispatch_lan_job(job.id))

    assert calls == ["upload", "start"]
    assert result is not None
    assert result.status is BambuCloudJobStatus.task_created


@pytest.mark.parametrize(
    "bad_url",
    [None, "http://artifacts.monofarm.test/object.3mf", "https://user:pw@artifacts.monofarm.test/a"],
)
def test_dispatch_rejects_missing_or_non_https_presigned_artifacts_before_command(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
    bad_url: str | None,
) -> None:
    data = b"safe-3mf"
    device = _device(db_session, test_org, name=f"Bad URL {bad_url}")
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix=uuid4().hex[:8],
        data=data,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )

    @contextmanager
    def source_path_factory(_stored_name: str, _org_id: int):
        yield _GuardedPath(data)

    with pytest.raises(
        agent_print_dispatch.AgentPrintDispatchIneligible,
        match="HTTPS presigned artifact URL",
    ):
        agent_print_dispatch.dispatch_job_to_agent(
            db_session,
            job_id=job.id,
            source_path_factory=source_path_factory,
            presigned_url_factory=lambda *_args, **_kwargs: bad_url,
        )

    assert (
        db_session.query(AgentCommand)
        .filter(AgentCommand.organization_id == test_org.id)
        .count()
        == 0
    )


def test_upload_success_creates_idempotent_strict_bambu_start_with_job_task_id(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"sliced-plate"
    device = _device(db_session, test_org, name="Start Agent")
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix="start",
        data=data,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, _ = _dispatch(db_session, job, data)
    upload_result = {
        "provider": "bambu",
        "remote_id": "cache/plate-start-acde1234.gcode.3mf",
        "file_name": "plate-start.gcode.3mf",
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    event = _event(
        db_session,
        dispatched.command,
        event_type="command.succeeded",
        payload=_succeeded_payload(upload_result),
        sequence=1,
    )

    first = agent_print_dispatch.process_agent_print_event(db_session, event)
    replay = agent_print_dispatch.process_agent_print_event(db_session, event)

    assert first.action == "start_created"
    assert replay.action == "start_replayed"
    start = (
        db_session.query(AgentCommand)
        .filter_by(
            organization_id=test_org.id,
            idempotency_key=f"agent-job:{job.id}:start",
        )
        .one()
    )
    assert start.command_type == "printer.start"
    assert start.agent_device_id == dispatched.command.agent_device_id
    assert start.payload_json == {
        "remote_id": upload_result["remote_id"],
        "file_name": upload_result["file_name"],
        "options": {
            "ams_mapping": [0, 1],
            "auto_bed_leveling": False,
            "flow_calibration": True,
            "plate_gcode": "Metadata/plate_2.gcode",
            "task_id": job.correlation_id,
            "timelapse": False,
            "use_ams": True,
        },
    }
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.task_creating


def test_event_ingestion_advances_a_job_scoped_upload_event(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"event-driven-3mf"
    device = _device(db_session, test_org, name="Event Bridge Agent")
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix="event-bridge",
        data=data,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, _ = _dispatch(db_session, job, data)

    result = ingest_agent_events(
        db_session,
        device=device,
        event_stream_id=device.id,
        events=[
            AgentEventIngestItem(
                sequence=1,
                printer_id=job.printer_id,
                command_id=dispatched.command.id,
                event_type="command.succeeded",
                payload=_succeeded_payload(
                    {
                        "provider": "bambu",
                        "remote_id": "event-bridge-acde1234.gcode.3mf",
                        "file_name": "plate-event-bridge.gcode.3mf",
                        "size": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                    }
                ),
                occurred_at_device=datetime.now(timezone.utc),
            )
        ],
    )

    assert result.accepted_count == 1
    assert (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:start")
        .count()
        == 1
    )
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.task_creating


def test_poison_success_event_is_acked_and_fails_only_its_job(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"poison-event-3mf"
    device = _device(db_session, test_org, name="Poison Event Agent")
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix="poison-event",
        data=data,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, _ = _dispatch(db_session, job, data)
    poison = AgentEventIngestItem(
        sequence=1,
        printer_id=job.printer_id,
        command_id=dispatched.command.id,
        event_type="command.succeeded",
        payload={"payload": {"provider": "bambu"}, "_ack_states": ["terminal"]},
        occurred_at_device=datetime.now(timezone.utc),
    )

    first = ingest_agent_events(
        db_session,
        device=device,
        event_stream_id=device.id,
        events=[poison],
    )
    replay = ingest_agent_events(
        db_session,
        device=device,
        event_stream_id=device.id,
        events=[poison],
    )

    assert first.accepted_count == 1
    assert first.highest_contiguous_sequence == 1
    assert replay.duplicate_count == 1
    assert replay.highest_contiguous_sequence == 1
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.failed
    assert job.error_code == "LAN_UPLOAD_FAILED"
    assert "fields do not match" in (job.error_msg or "")


def test_start_success_reaches_printing_and_needs_reconcile_never_replays_start(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"reconcile-3mf"
    device = _device(db_session, test_org, name="Reconcile Agent")
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix="reconcile",
        data=data,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, _ = _dispatch(db_session, job, data)
    upload_result = {
        "provider": "bambu",
        "remote_id": "plate-reconcile-acde1234.gcode.3mf",
        "file_name": "plate-reconcile.gcode.3mf",
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    upload_event = _event(
        db_session,
        dispatched.command,
        event_type="command.succeeded",
        payload=_succeeded_payload(upload_result),
        sequence=1,
    )
    agent_print_dispatch.process_agent_print_event(db_session, upload_event)
    start = (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:start")
        .one()
    )
    ambiguous = _event(
        db_session,
        start,
        event_type="command.needs_reconcile",
        payload={
            "attempt": 1,
            "error": "Bambu push state did not contain matching task_id",
            "reason": "retryable_failure_after_start",
        },
        sequence=2,
    )

    first = agent_print_dispatch.process_agent_print_event(db_session, ambiguous)
    replay = agent_print_dispatch.process_agent_print_event(db_session, ambiguous)

    assert first.action == "reconcile_created"
    assert replay.action == "reconcile_replayed"
    assert (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:start")
        .count()
        == 1
    )
    reconcile = (
        db_session.query(AgentCommand)
        .filter_by(idempotency_key=f"agent-job:{job.id}:reconcile")
        .one()
    )
    assert reconcile.command_type == "printer.reconcile"
    assert reconcile.payload_json == start.payload_json

    succeeded = _event(
        db_session,
        reconcile,
        event_type="command.succeeded",
        payload=_succeeded_payload(
            {
                "provider": "bambu",
                "remote_id": upload_result["remote_id"],
                "state": "printing",
                "printer_reference": job.correlation_id,
            }
        ),
        sequence=3,
    )
    result = agent_print_dispatch.process_agent_print_event(db_session, succeeded)

    assert result.action == "printing_confirmed"
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.printing
    assert job.bambu_task_id == job.correlation_id
    confirmed_reason = job.status_reason

    stale = agent_print_dispatch.process_agent_print_event(db_session, ambiguous)

    db_session.refresh(job)
    assert stale.action == "stale_reconcile_ignored"
    assert job.status is BambuCloudJobStatus.printing
    assert job.status_reason == confirmed_reason


@pytest.mark.parametrize(
    ("stage", "expected_error_code"),
    [
        ("upload", "LAN_UPLOAD_FAILED"),
        ("start", "LAN_MQTT_FAILED"),
    ],
)
def test_failed_agent_stage_moves_only_its_job_to_failed(
    db_session: Session,
    test_org: Organization,
    monkeypatch: pytest.MonkeyPatch,
    stage: str,
    expected_error_code: str,
) -> None:
    data = b"failure-3mf"
    device = _device(db_session, test_org, name=f"Failure Agent {stage}")
    _printer, _gcode, job = _bambu_job(
        db_session,
        test_org,
        suffix=f"failure-{stage}",
        data=data,
    )
    monkeypatch.setattr(
        agent_print_dispatch.tunnel,
        "connected_device_id",
        lambda _organization_id: device.id,
    )
    dispatched, _ = _dispatch(db_session, job, data)
    command = dispatched.command
    if stage == "start":
        upload_result = {
            "provider": "bambu",
            "remote_id": "failure.gcode.3mf",
            "file_name": f"plate-failure-{stage}.gcode.3mf",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        upload_event = _event(
            db_session,
            command,
            event_type="command.succeeded",
            payload=_succeeded_payload(upload_result),
            sequence=1,
        )
        agent_print_dispatch.process_agent_print_event(db_session, upload_event)
        command = (
            db_session.query(AgentCommand)
            .filter_by(idempotency_key=f"agent-job:{job.id}:start")
            .one()
        )
    failed = _event(
        db_session,
        command,
        event_type="command.failed",
        payload={"attempt": 1, "error": "simulated provider failure"},
        sequence=2,
    )

    result = agent_print_dispatch.process_agent_print_event(db_session, failed)

    assert result.action == "job_failed"
    db_session.refresh(job)
    assert job.status is BambuCloudJobStatus.failed
    assert job.error_code == expected_error_code
    assert "simulated provider failure" in (job.error_msg or "")
