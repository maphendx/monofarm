"""Durable print orchestration through protocol-v2 agent commands.

Only unchanged artifacts enter this bridge. Bambu LAN and standard Moonraker
jobs use the same durable upload/start/reconcile stages; provider-specific
validation keeps transformed Moonraker jobs on the proven legacy path.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, ContextManager, Protocol
from urllib.parse import urlsplit
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.agent import AgentCommand, AgentDevice, AgentEvent
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.gcode_file import GcodeFile
from app.models.printer import Printer, PrinterKind
from app.services import storage, tunnel
from app.services.agent_commands import canonical_payload_sha256, create_agent_command
from app.services.agent_routing import device_can_access_printer
from app.services.bambu_errors import BambuErrorCode, error_details
from app.services.bambu_job_state import TERMINAL_STATUSES, transition_job


FILE_HASH_CHUNK_SIZE = 64 * 1024
ARTIFACT_URL_TTL_SECONDS = 3600
COMMAND_DEADLINE_SECONDS = 3300

REQUIRED_AGENT_CAPABILITIES = (
    "durable_commands_v2",
    "provider_adapters_v2",
)
REQUIRED_AGENT_SCOPES = (
    "agent:connect",
    "commands:read",
    "events:write",
    "status:write",
)

_JOB_COMMAND_KEY = re.compile(r"agent-job:([1-9][0-9]*):(upload|start|reconcile)\Z")
_PLATE_GCODE = re.compile(r"Metadata/plate_([1-9][0-9]*)\.gcode\Z")
_EVENT_TYPES = frozenset(
    {"command.succeeded", "command.failed", "command.needs_reconcile"}
)
_STAGE_COMMAND_TYPES = {
    "upload": "printer.upload",
    "start": "printer.start",
    "reconcile": "printer.reconcile",
}
_SUPPORTED_DISPATCH_KINDS = frozenset({"bambu_lan", "moonraker"})


class AgentPrintDispatchError(RuntimeError):
    """The durable bridge encountered an invalid or conflicting state."""


class AgentPrintDispatchIneligible(AgentPrintDispatchError):
    """The job cannot safely use the protocol-v2 agent path."""


class _ReadablePath(Protocol):
    def open(self, mode: str) -> ContextManager[BinaryIO]: ...


SourcePathFactory = Callable[[str, int], ContextManager[_ReadablePath]]
PresignedURLFactory = Callable[..., str | None]
SessionFactory = Callable[[], ContextManager[Session]]


@dataclass(frozen=True, slots=True)
class AgentPrintDispatchEligibility:
    eligible: bool
    reason: str | None
    device_id: UUID | None


@dataclass(frozen=True, slots=True)
class AgentPrintDispatchResult:
    job_id: int
    command: AgentCommand
    created: bool


@dataclass(frozen=True, slots=True)
class AgentPrintEventResult:
    action: str
    job_id: int | None
    command_id: UUID | None = None


def try_dispatch_job_to_agent(
    job_id: int,
    *,
    dispatch_kind: str,
    session_factory: SessionFactory | None = None,
    source_path_factory: SourcePathFactory = storage.local_path_for,
    presigned_url_factory: PresignedURLFactory = storage.presigned_url,
) -> AgentPrintDispatchResult | None:
    """Claim an eligible queued job for durable v2, otherwise preserve legacy.

    ``dispatch_kind`` is checked before opening the database so an unrelated
    numeric job id never enters the print bridge.
    """
    if dispatch_kind not in _SUPPORTED_DISPATCH_KINDS:
        return None
    if session_factory is None:
        from app.core.db import SessionLocal

        session_factory = SessionLocal

    with session_factory() as db:
        job = (
            db.query(BambuCloudJob)
            .filter(BambuCloudJob.id == job_id)
            .with_for_update()
            .first()
        )
        if job is None:
            return None
        try:
            return dispatch_job_to_agent(
                db,
                job_id=job.id,
                dispatch_kind=dispatch_kind,
                source_path_factory=source_path_factory,
                presigned_url_factory=presigned_url_factory,
            )
        except AgentPrintDispatchIneligible:
            return None


def agent_print_dispatch_eligibility(
    db: Session,
    *,
    organization_id: int,
    printer_id: int | None = None,
) -> AgentPrintDispatchEligibility:
    """Return whether the organization's exact live socket is v2-print ready."""
    device_id = tunnel.connected_device_id(organization_id)
    if device_id is None:
        return AgentPrintDispatchEligibility(False, "agent_not_connected", None)

    device = (
        db.query(AgentDevice)
        .filter(
            AgentDevice.id == device_id,
            AgentDevice.organization_id == organization_id,
        )
        .first()
    )
    if device is None:
        return AgentPrintDispatchEligibility(False, "device_not_found", device_id)
    if device.revoked_at is not None:
        return AgentPrintDispatchEligibility(False, "device_revoked", device_id)
    if not device.is_paired:
        return AgentPrintDispatchEligibility(False, "device_not_paired", device_id)
    if printer_id is None and device.site_id is not None:
        # Printer currently has no site assignment column. Routing every org
        # printer to a site-scoped device would be an arbitrary cross-site
        # choice, so the bridge stays disabled until that mapping exists.
        return AgentPrintDispatchEligibility(
            False,
            "printer_site_assignment_unavailable",
            device_id,
        )
    if printer_id is not None:
        printer = (
            db.query(Printer)
            .filter(
                Printer.id == printer_id,
                Printer.organization_id == organization_id,
            )
            .first()
        )
        if printer is None:
            return AgentPrintDispatchEligibility(False, "printer_not_found", device_id)
        if not device_can_access_printer(db, device, printer):
            return AgentPrintDispatchEligibility(
                False,
                "printer_not_assigned_to_device",
                device_id,
            )

    capabilities = set(device.capabilities or [])
    for capability in REQUIRED_AGENT_CAPABILITIES:
        if capability not in capabilities:
            return AgentPrintDispatchEligibility(
                False,
                f"missing_capability:{capability}",
                device_id,
            )
    scopes = set(device.scopes or [])
    for scope in REQUIRED_AGENT_SCOPES:
        if scope not in scopes:
            return AgentPrintDispatchEligibility(False, f"missing_scope:{scope}", device_id)
    return AgentPrintDispatchEligibility(True, None, device_id)


def dispatch_job_to_agent(
    db: Session,
    *,
    job_id: int,
    dispatch_kind: str | None = None,
    source_path_factory: SourcePathFactory = storage.local_path_for,
    presigned_url_factory: PresignedURLFactory = storage.presigned_url,
    now: datetime | None = None,
) -> AgentPrintDispatchResult:
    """Create one durable ``printer.upload`` command for an eligible job.

    Storage is read in fixed-size chunks. The signed URL is put only in the
    command payload and is never logged or persisted on the job itself.
    """
    current_time = _aware(now or datetime.now(timezone.utc))
    job = db.get(BambuCloudJob, job_id)
    if job is None:
        raise AgentPrintDispatchIneligible("print job not found")
    resolved_dispatch_kind = _resolve_dispatch_kind(job, dispatch_kind)

    eligibility = agent_print_dispatch_eligibility(
        db,
        organization_id=job.organization_id,
        printer_id=job.printer_id,
    )
    if not eligibility.eligible or eligibility.device_id is None:
        raise AgentPrintDispatchIneligible(eligibility.reason or "agent is ineligible")

    printer = _org_printer(db, job)
    gcode = _org_gcode(db, job)
    if resolved_dispatch_kind == "bambu_lan":
        _validate_bambu_lan_target(job, printer, gcode)
    else:
        _validate_moonraker_target(job, printer, gcode)

    idempotency_key = _stage_key(job.id, "upload")
    existing = _existing_stage_command(db, job, idempotency_key, "upload")
    if existing is not None:
        if existing.agent_device_id != eligibility.device_id:
            raise AgentPrintDispatchError("job upload is already bound to another agent device")
        _advance_job_to_uploading(
            job,
            size=_required_nonnegative_int(existing.payload_json.get("expected_size"), "expected_size"),
            sha256=_required_sha256(existing.payload_json.get("expected_sha256")),
            now=current_time,
        )
        db.commit()
        return AgentPrintDispatchResult(job.id, existing, False)
    if job.status != BambuCloudJobStatus.queued:
        raise AgentPrintDispatchIneligible(
            f"job already entered another dispatch path: {job.status.value}"
        )

    with source_path_factory(gcode.stored_name, job.organization_id) as source_path:
        size, sha256 = _hash_file(source_path)
    _validate_source_integrity(job, gcode, size=size, sha256=sha256)

    source_url = presigned_url_factory(
        gcode.stored_name,
        job.organization_id,
        expires=ARTIFACT_URL_TTL_SECONDS,
    )
    _require_https_presigned_url(source_url)
    expires_at = current_time + timedelta(seconds=ARTIFACT_URL_TTL_SECONDS)
    payload = {
        "source_url": source_url,
        "file_name": _command_file_name(job.file_name or gcode.original_name),
        "expected_size": size,
        "expected_sha256": sha256,
        "expires_at": expires_at.isoformat(),
    }
    command, created = create_agent_command(
        db,
        organization_id=job.organization_id,
        agent_device_id=eligibility.device_id,
        printer_id=job.printer_id,
        command_type="printer.upload",
        payload=payload,
        supplied_payload_sha256=None,
        idempotency_key=idempotency_key,
        deadline_at=current_time + timedelta(seconds=COMMAND_DEADLINE_SECONDS),
    )
    _advance_job_to_uploading(job, size=size, sha256=sha256, now=current_time)
    db.commit()
    db.refresh(command)
    return AgentPrintDispatchResult(job.id, command, created)


def process_agent_print_event(
    db: Session,
    event: AgentEvent,
    *,
    now: datetime | None = None,
) -> AgentPrintEventResult:
    """Process one durable job command event idempotently.

    Events not carrying this service's job-scoped idempotency key are ignored.
    A start ambiguity creates an explicit reconciliation command; it never
    creates or replays another physical start.
    """
    if event.event_type not in _EVENT_TYPES or event.command_id is None:
        return AgentPrintEventResult("ignored", None)
    command = (
        db.query(AgentCommand)
        .filter(
            AgentCommand.id == event.command_id,
            AgentCommand.organization_id == event.organization_id,
            AgentCommand.agent_device_id == event.agent_device_id,
        )
        .first()
    )
    if command is None:
        return AgentPrintEventResult("ignored", None)
    match = _JOB_COMMAND_KEY.fullmatch(command.idempotency_key)
    if match is None:
        return AgentPrintEventResult("ignored", None)
    job_id, stage = int(match.group(1)), match.group(2)
    if command.command_type != _STAGE_COMMAND_TYPES[stage]:
        raise AgentPrintDispatchError("job command stage does not match command type")
    job = (
        db.query(BambuCloudJob)
        .filter(
            BambuCloudJob.id == job_id,
            BambuCloudJob.organization_id == event.organization_id,
            BambuCloudJob.printer_id == command.printer_id,
        )
        .first()
    )
    if job is None:
        return AgentPrintEventResult("ignored", None)
    if job.status in TERMINAL_STATUSES:
        return AgentPrintEventResult("terminal_job_ignored", job.id, command.id)

    current_time = _aware(now or datetime.now(timezone.utc))
    if event.event_type == "command.failed":
        return _process_failed_event(db, job, command, stage, event.payload_json, current_time)
    if event.event_type == "command.needs_reconcile":
        return _process_reconcile_needed(db, job, command, stage, current_time)
    return _process_succeeded_event(db, job, command, stage, event.payload_json, current_time)


def reject_agent_print_event(
    db: Session,
    event: AgentEvent,
    error: AgentPrintDispatchError,
    *,
    now: datetime | None = None,
) -> AgentPrintEventResult:
    """Consume a poison job event without blocking the device outbox forever."""
    if event.command_id is None:
        return AgentPrintEventResult("invalid_event_ignored", None)
    command = (
        db.query(AgentCommand)
        .filter(
            AgentCommand.id == event.command_id,
            AgentCommand.organization_id == event.organization_id,
            AgentCommand.agent_device_id == event.agent_device_id,
        )
        .first()
    )
    match = _JOB_COMMAND_KEY.fullmatch(command.idempotency_key) if command else None
    if command is None or match is None:
        return AgentPrintEventResult("invalid_event_ignored", None)
    job_id, stage = int(match.group(1)), match.group(2)
    job = (
        db.query(BambuCloudJob)
        .filter(
            BambuCloudJob.id == job_id,
            BambuCloudJob.organization_id == event.organization_id,
            BambuCloudJob.printer_id == command.printer_id,
        )
        .first()
    )
    if job is None:
        return AgentPrintEventResult("invalid_event_ignored", None)
    return _process_failed_event(
        db,
        job,
        command,
        stage,
        {"error": f"event_validation_failed: {error}"},
        _aware(now or datetime.now(timezone.utc)),
    )


def _process_succeeded_event(
    db: Session,
    job: BambuCloudJob,
    command: AgentCommand,
    stage: str,
    event_payload: Mapping[str, Any],
    now: datetime,
) -> AgentPrintEventResult:
    result = _execution_result(event_payload)
    if stage == "upload":
        _validate_upload_result(job, command, result)
        gcode = _org_gcode(db, job)
        start_payload = _build_start_payload(job, gcode, result)
        start, created = _ensure_stage_command(
            db,
            job=job,
            device_id=command.agent_device_id,
            stage="start",
            payload=start_payload,
            now=now,
        )
        _advance_job_after_upload(job, now=now)
        db.commit()
        return AgentPrintEventResult(
            "start_created" if created else "start_replayed",
            job.id,
            start.id,
        )

    if stage == "start":
        _validate_start_result(job, command, result)
        if _is_moonraker_job(job):
            _advance_moonraker_job_to_acknowledged(job, now=now)
            action = "printer_ack_confirmed"
        else:
            _advance_bambu_job_to_confirmed(job, state="printing", now=now)
            action = "printing_confirmed"
        db.commit()
        return AgentPrintEventResult(action, job.id, command.id)

    _validate_reconcile_result(job, command, result)
    state = str(result["state"])
    if _is_moonraker_job(job):
        _advance_moonraker_job_to_acknowledged(job, now=now)
        action = "printer_ack_confirmed"
    else:
        _advance_bambu_job_to_confirmed(job, state=state, now=now)
        action = "printing_confirmed" if state == "printing" else "printer_ack_confirmed"
    db.commit()
    return AgentPrintEventResult(action, job.id, command.id)


def _process_reconcile_needed(
    db: Session,
    job: BambuCloudJob,
    command: AgentCommand,
    stage: str,
    now: datetime,
) -> AgentPrintEventResult:
    if job.status in {
        BambuCloudJobStatus.acknowledged,
        BambuCloudJobStatus.printing,
        BambuCloudJobStatus.paused,
    }:
        return AgentPrintEventResult("stale_reconcile_ignored", job.id, command.id)
    if stage != "start":
        return _process_failed_event(
            db,
            job,
            command,
            stage,
            {"error": "unexpected reconciliation request for non-start command"},
            now,
        )
    payload = dict(command.payload_json)
    _require_start_payload_shape(job, payload)
    reconcile, created = _ensure_stage_command(
        db,
        job=job,
        device_id=command.agent_device_id,
        stage="reconcile",
        payload=payload,
        now=now,
    )
    provider_name = "Moonraker" if _is_moonraker_job(job) else "Bambu LAN"
    job.status_reason = f"Agent is reconciling an ambiguous {provider_name} start"
    job.updated_at = now
    db.commit()
    return AgentPrintEventResult(
        "reconcile_created" if created else "reconcile_replayed",
        job.id,
        reconcile.id,
    )


def _process_failed_event(
    db: Session,
    job: BambuCloudJob,
    command: AgentCommand,
    stage: str,
    payload: Mapping[str, Any],
    now: datetime,
) -> AgentPrintEventResult:
    if job.status in {
        BambuCloudJobStatus.printing,
        BambuCloudJobStatus.paused,
        *TERMINAL_STATUSES,
    }:
        return AgentPrintEventResult("stale_failure_ignored", job.id, command.id)
    raw_error = payload.get("error")
    error = raw_error.strip()[:2000] if isinstance(raw_error, str) and raw_error.strip() else "Agent command failed"
    if _is_moonraker_job(job):
        error_code = (
            BambuErrorCode.MOONRAKER_UPLOAD_FAILED
            if stage == "upload"
            else BambuErrorCode.MOONRAKER_START_FAILED
        )
    else:
        error_code = (
            BambuErrorCode.LAN_UPLOAD_FAILED
            if stage == "upload"
            else BambuErrorCode.LAN_MQTT_FAILED
        )
    transition_job(
        job,
        BambuCloudJobStatus.failed,
        reason=f"Agent {stage} command failed",
        now=now,
        error_code=error_code.value,
        error_msg=error,
        error_details_json=error_details(error_code, stage=stage, command_id=str(command.id)),
    )
    db.commit()
    return AgentPrintEventResult("job_failed", job.id, command.id)


def _ensure_stage_command(
    db: Session,
    *,
    job: BambuCloudJob,
    device_id: UUID,
    stage: str,
    payload: dict[str, Any],
    now: datetime,
) -> tuple[AgentCommand, bool]:
    key = _stage_key(job.id, stage)
    existing = _existing_stage_command(db, job, key, stage)
    digest = canonical_payload_sha256(payload)
    if existing is not None:
        if existing.agent_device_id != device_id or existing.payload_sha256 != digest:
            raise AgentPrintDispatchError("job command idempotency conflict")
        return existing, False
    return create_agent_command(
        db,
        organization_id=job.organization_id,
        agent_device_id=device_id,
        printer_id=job.printer_id,
        command_type=_STAGE_COMMAND_TYPES[stage],
        payload=payload,
        supplied_payload_sha256=digest,
        idempotency_key=key,
        deadline_at=now + timedelta(seconds=COMMAND_DEADLINE_SECONDS),
    )


def _existing_stage_command(
    db: Session,
    job: BambuCloudJob,
    key: str,
    stage: str,
) -> AgentCommand | None:
    command = (
        db.query(AgentCommand)
        .filter(
            AgentCommand.organization_id == job.organization_id,
            AgentCommand.idempotency_key == key,
        )
        .first()
    )
    if command is not None and (
        command.printer_id != job.printer_id
        or command.command_type != _STAGE_COMMAND_TYPES[stage]
    ):
        raise AgentPrintDispatchError("job command idempotency key is already in use")
    return command


def _build_start_payload(
    job: BambuCloudJob,
    gcode: GcodeFile,
    upload_result: Mapping[str, Any],
) -> dict[str, Any]:
    if _is_moonraker_job(job):
        return {
            "remote_id": _required_remote_id(upload_result.get("remote_id")),
            "file_name": _required_plain_file_name(upload_result.get("file_name")),
        }

    try:
        UUID(job.correlation_id)
    except (ValueError, TypeError, AttributeError) as exc:
        raise AgentPrintDispatchError("job correlation_id is not a UUID") from exc
    request = job.request_payload_json or {}
    if not isinstance(request, Mapping):
        raise AgentPrintDispatchError("job request payload is invalid")
    if isinstance(request.get("platecycler"), Mapping):
        raise AgentPrintDispatchIneligible("PlateCycler requires a prepared artifact")

    metadata = gcode.filament_meta or {}
    plate_gcode = metadata.get("bambu_plate_gcode") if isinstance(metadata, Mapping) else None
    if not isinstance(plate_gcode, str) or not _PLATE_GCODE.fullmatch(plate_gcode):
        raise AgentPrintDispatchIneligible("Bambu plate gcode metadata is missing")

    use_ams = _optional_bool(request.get("use_ams"), "use_ams", default=True)
    options: dict[str, Any] = {
        "auto_bed_leveling": _optional_bool(
            request.get("auto_bed_leveling"),
            "auto_bed_leveling",
            default=True,
        ),
        "flow_calibration": _optional_bool(
            request.get("flow_calibration"),
            "flow_calibration",
            default=False,
        ),
        "plate_gcode": plate_gcode,
        "task_id": job.correlation_id,
        "timelapse": _optional_bool(
            request.get("timelapse"),
            "timelapse",
            default=False,
        ),
        "use_ams": use_ams,
    }
    mapping = request.get("ams_mapping")
    if use_ams and mapping is not None:
        options["ams_mapping"] = _validated_ams_mapping(mapping)
    payload = {
        "remote_id": _required_remote_id(upload_result.get("remote_id")),
        "file_name": _required_plain_file_name(upload_result.get("file_name")),
        "options": options,
    }
    _require_start_payload_shape(job, payload)
    return payload


def _validate_upload_result(
    job: BambuCloudJob,
    command: AgentCommand,
    result: Mapping[str, Any],
) -> None:
    _require_exact_fields(
        result,
        {"provider", "remote_id", "file_name", "size", "sha256"},
        "upload result",
    )
    _require_job_provider(job, result.get("provider"))
    remote_id = _required_remote_id(result.get("remote_id"))
    file_name = _required_plain_file_name(result.get("file_name"))
    size = _required_nonnegative_int(result.get("size"), "size")
    sha256 = _required_sha256(result.get("sha256"))
    expected = command.payload_json
    if (
        file_name != expected.get("file_name")
        or size != expected.get("expected_size")
        or sha256 != expected.get("expected_sha256")
    ):
        raise AgentPrintDispatchError("upload result does not match the requested artifact")
    if _is_moonraker_job(job) and remote_id != file_name:
        raise AgentPrintDispatchError("Moonraker upload result is not correlated to the exact filename")


def _validate_start_result(
    job: BambuCloudJob,
    command: AgentCommand,
    result: Mapping[str, Any],
) -> None:
    _require_exact_fields(
        result,
        {"provider", "remote_id", "printer_reference"},
        "start result",
    )
    _require_job_provider(job, result.get("provider"))
    remote_id = _required_remote_id(result.get("remote_id"))
    if remote_id != command.payload_json.get("remote_id"):
        raise AgentPrintDispatchError("start result remote_id does not match command")
    expected_reference = remote_id if _is_moonraker_job(job) else job.correlation_id
    if result.get("printer_reference") != expected_reference:
        raise AgentPrintDispatchError("start result is not correlated to the job")


def _validate_reconcile_result(
    job: BambuCloudJob,
    command: AgentCommand,
    result: Mapping[str, Any],
) -> None:
    _require_exact_fields(
        result,
        {"provider", "remote_id", "state", "printer_reference"},
        "reconcile result",
    )
    _require_job_provider(job, result.get("provider"))
    remote_id = _required_remote_id(result.get("remote_id"))
    if remote_id != command.payload_json.get("remote_id"):
        raise AgentPrintDispatchError("reconcile result remote_id does not match command")
    valid_states = {"printing"} if _is_moonraker_job(job) else {"printing", "printer_ack"}
    if result.get("state") not in valid_states:
        raise AgentPrintDispatchError("reconcile result did not confirm the print")
    expected_reference = remote_id if _is_moonraker_job(job) else job.correlation_id
    if result.get("printer_reference") != expected_reference:
        raise AgentPrintDispatchError("reconcile result is not correlated to the job")


def _execution_result(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    _require_exact_fields(payload, {"payload", "_ack_states"}, "command success event")
    result = payload.get("payload")
    ack_states = payload.get("_ack_states")
    if not isinstance(result, Mapping) or not isinstance(ack_states, list) or not all(
        isinstance(state, str) for state in ack_states
    ):
        raise AgentPrintDispatchError("command success event payload is invalid")
    return result


def _advance_job_to_uploading(
    job: BambuCloudJob,
    *,
    size: int,
    sha256: str,
    now: datetime,
) -> None:
    if job.status == BambuCloudJobStatus.queued:
        transition_job(
            job,
            BambuCloudJobStatus.validating,
            reason="Validated for durable agent dispatch",
            now=now,
            file_size=size,
            file_sha256=sha256,
        )
    if job.status == BambuCloudJobStatus.validating:
        transition_job(
            job,
            BambuCloudJobStatus.uploading,
            reason="Artifact queued for the connected farm agent",
            now=now,
            progress_pct=0,
        )


def _advance_job_after_upload(job: BambuCloudJob, *, now: datetime) -> None:
    if _is_moonraker_job(job):
        if job.status != BambuCloudJobStatus.uploading:
            raise AgentPrintDispatchError(
                f"cannot create Moonraker start command from job status {job.status.value}"
            )
        job.uploaded_at = job.uploaded_at or now
        job.progress_pct = 100
        job.status_reason = "Agent upload complete; durable Moonraker start queued"
        job.updated_at = now
        return
    _advance_bambu_job_to_task_creating(job, now=now)


def _advance_bambu_job_to_task_creating(job: BambuCloudJob, *, now: datetime) -> None:
    if job.status == BambuCloudJobStatus.uploading:
        transition_job(
            job,
            BambuCloudJobStatus.task_creating,
            reason="Agent upload complete; durable start queued",
            now=now,
            progress_pct=100,
        )
    elif job.status not in {
        BambuCloudJobStatus.task_creating,
        BambuCloudJobStatus.task_created,
        BambuCloudJobStatus.acknowledged,
        BambuCloudJobStatus.printing,
        BambuCloudJobStatus.paused,
    }:
        raise AgentPrintDispatchError(
            f"cannot create start command from job status {job.status.value}"
        )


def _advance_bambu_job_to_confirmed(
    job: BambuCloudJob,
    *,
    state: str,
    now: datetime,
) -> None:
    _advance_bambu_job_to_task_creating(job, now=now)
    job.bambu_task_id = job.correlation_id
    if job.status == BambuCloudJobStatus.task_creating:
        transition_job(
            job,
            BambuCloudJobStatus.task_created,
            reason="Agent delivered the correlated Bambu LAN start",
            now=now,
        )
    target = (
        BambuCloudJobStatus.printing
        if state == "printing"
        else BambuCloudJobStatus.acknowledged
    )
    if job.status == BambuCloudJobStatus.task_created:
        transition_job(
            job,
            target,
            reason="Agent confirmed the correlated Bambu LAN print",
            now=now,
        )
    elif target == BambuCloudJobStatus.printing and job.status == BambuCloudJobStatus.acknowledged:
        transition_job(
            job,
            BambuCloudJobStatus.printing,
            reason="Agent confirmed the correlated Bambu LAN print",
            now=now,
        )


def _advance_moonraker_job_to_acknowledged(
    job: BambuCloudJob,
    *,
    now: datetime,
) -> None:
    if job.status == BambuCloudJobStatus.uploading:
        transition_job(
            job,
            BambuCloudJobStatus.acknowledged,
            reason="Agent confirmed the exact Moonraker filename start",
            now=now,
            last_mqtt_at=now,
        )
        return
    if job.status in {
        BambuCloudJobStatus.acknowledged,
        BambuCloudJobStatus.printing,
        BambuCloudJobStatus.paused,
    }:
        job.last_mqtt_at = now
        job.updated_at = now
        return
    raise AgentPrintDispatchError(
        f"cannot confirm Moonraker start from job status {job.status.value}"
    )


def _validate_bambu_lan_target(
    job: BambuCloudJob,
    printer: Printer,
    gcode: GcodeFile,
) -> None:
    if job.status in TERMINAL_STATUSES:
        raise AgentPrintDispatchIneligible(f"job is terminal: {job.status.value}")
    if job.dispatch_mode != "lan":
        raise AgentPrintDispatchIneligible("job is not a Bambu LAN dispatch")
    if printer.kind != PrinterKind.bambu or not printer.bambu_lan_mode:
        raise AgentPrintDispatchIneligible("only configured Bambu LAN jobs are supported")
    if not (
        printer.is_active
        and printer.bambu_dev_id
        and printer.bambu_dev_ip
        and printer.bambu_access_code
        and printer.bambu_model
    ):
        raise AgentPrintDispatchIneligible("Bambu LAN printer configuration is incomplete")
    file_name = job.file_name or gcode.original_name
    if not "".join(Path(file_name).suffixes).lower().endswith(".3mf"):
        raise AgentPrintDispatchIneligible("Bambu LAN requires a 3MF artifact")
    request = job.request_payload_json or {}
    if not isinstance(request, Mapping):
        raise AgentPrintDispatchIneligible("job request payload is invalid")
    start_via = request.get("start_via", "lan")
    if not isinstance(start_via, str) or start_via.strip().lower() != "lan":
        raise AgentPrintDispatchIneligible("hybrid cloud start remains on the legacy path")
    if isinstance(request.get("platecycler"), Mapping):
        raise AgentPrintDispatchIneligible("PlateCycler requires a prepared artifact")


def _validate_moonraker_target(
    job: BambuCloudJob,
    printer: Printer,
    gcode: GcodeFile,
) -> None:
    if job.status in TERMINAL_STATUSES:
        raise AgentPrintDispatchIneligible(f"job is terminal: {job.status.value}")
    if job.dispatch_mode != "moonraker":
        raise AgentPrintDispatchIneligible("job is not a Moonraker dispatch")
    if (
        printer.kind not in {PrinterKind.snapmaker_u1, PrinterKind.other}
        or not printer.is_active
        or not printer.moonraker_url
    ):
        raise AgentPrintDispatchIneligible("only configured Moonraker printers are supported")

    from app.services import moonraker as moonraker_service
    from app.services.moonraker_dispatch import validate_moonraker_filename

    file_name = job.file_name or gcode.original_name
    try:
        validate_moonraker_filename(
            printer.kind,
            file_name,
        )
        if _command_file_name(file_name) != Path(file_name).name:
            raise AgentPrintDispatchIneligible(
                "Moonraker filename requires legacy normalization"
            )
    except moonraker_service.MoonrakerError as exc:
        raise AgentPrintDispatchIneligible(str(exc)) from exc

    request = job.request_payload_json or {}
    if not isinstance(request, Mapping):
        raise AgentPrintDispatchIneligible("job request payload is invalid")
    slot_map = _normalized_slot_map(request.get("slot_map"))
    if printer.kind == PrinterKind.snapmaker_u1 and slot_map:
        raise AgentPrintDispatchIneligible(
            "Snapmaker U1 slot mapping requires the legacy mapping script"
        )
    if any(source != target for source, target in slot_map.items()):
        raise AgentPrintDispatchIneligible("slot remapping requires a transformed artifact")
    for option in (
        "auto_bed_leveling",
        "timelapse",
        "ai_detection",
        "calibrate_slots",
    ):
        if request.get(option) is not None:
            raise AgentPrintDispatchIneligible(
                f"Moonraker option {option} requires a transformed artifact"
            )
    if _moonraker_metadata_requires_transformation(gcode.filament_meta):
        raise AgentPrintDispatchIneligible(
            "Moonraker filament metadata requires a transformed artifact"
        )


def _normalized_slot_map(value: object) -> dict[int, int]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise AgentPrintDispatchIneligible("Moonraker slot_map is invalid")
    normalized: dict[int, int] = {}
    for raw_source, raw_target in value.items():
        if isinstance(raw_source, bool) or isinstance(raw_target, bool):
            raise AgentPrintDispatchIneligible("Moonraker slot_map is invalid")
        try:
            source = int(raw_source)
            target = int(raw_target)
        except (TypeError, ValueError) as exc:
            raise AgentPrintDispatchIneligible("Moonraker slot_map is invalid") from exc
        if source < 0 or target < 0:
            raise AgentPrintDispatchIneligible("Moonraker slot_map is invalid")
        normalized[source] = target
    return normalized


def _moonraker_metadata_requires_transformation(value: object) -> bool:
    if not isinstance(value, Mapping):
        return False
    used_g = value.get("used_g") or []
    if not isinstance(used_g, list):
        return False
    colors = value.get("colors") or []
    types = value.get("types") or []
    if not isinstance(colors, list) or not isinstance(types, list):
        return False
    slot_count = max(len(colors), len(types))
    if not used_g or not slot_count:
        return False
    used_slots = {
        index
        for index in range(slot_count)
        if index >= len(used_g)
        or not isinstance(used_g[index], (int, float))
        or used_g[index] > 0
    }
    return 0 < len(used_slots) < slot_count


def _resolve_dispatch_kind(
    job: BambuCloudJob,
    requested: str | None,
) -> str:
    expected = {
        "lan": "bambu_lan",
        "moonraker": "moonraker",
    }.get(job.dispatch_mode)
    if expected is None:
        raise AgentPrintDispatchIneligible(
            f"job dispatch mode {job.dispatch_mode!r} is not supported by durable agent commands"
        )
    if requested is not None and requested != expected:
        raise AgentPrintDispatchIneligible("dispatch kind does not match the job")
    return expected


def _is_moonraker_job(job: BambuCloudJob) -> bool:
    return job.dispatch_mode == "moonraker"


def _validate_source_integrity(
    job: BambuCloudJob,
    gcode: GcodeFile,
    *,
    size: int,
    sha256: str,
) -> None:
    if size <= 0:
        raise AgentPrintDispatchIneligible("artifact is empty")
    if gcode.size_bytes != size:
        raise AgentPrintDispatchIneligible("artifact size no longer matches GcodeFile")
    if job.file_size is not None and job.file_size != size:
        raise AgentPrintDispatchIneligible("artifact size no longer matches the job")
    if job.file_sha256 is not None and job.file_sha256 != sha256:
        raise AgentPrintDispatchIneligible("artifact hash no longer matches the job")


def _hash_file(path: _ReadablePath) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(FILE_HASH_CHUNK_SIZE):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def _org_printer(db: Session, job: BambuCloudJob) -> Printer:
    printer = (
        db.query(Printer)
        .filter(
            Printer.id == job.printer_id,
            Printer.organization_id == job.organization_id,
        )
        .first()
    )
    if printer is None:
        raise AgentPrintDispatchIneligible("job printer not found in organization")
    return printer


def _org_gcode(db: Session, job: BambuCloudJob) -> GcodeFile:
    if job.gcode_file_id is None:
        raise AgentPrintDispatchIneligible("job has no GcodeFile")
    gcode = (
        db.query(GcodeFile)
        .filter(
            GcodeFile.id == job.gcode_file_id,
            GcodeFile.organization_id == job.organization_id,
        )
        .first()
    )
    if gcode is None:
        raise AgentPrintDispatchIneligible("job GcodeFile not found in organization")
    return gcode


def _stage_key(job_id: int, stage: str) -> str:
    return f"agent-job:{job_id}:{stage}"


def _command_file_name(value: str) -> str:
    base = Path(value).name
    if not base or "\x00" in base:
        raise AgentPrintDispatchIneligible("artifact file name is invalid")
    if len(base) <= 180:
        return base
    suffix = "".join(Path(base).suffixes)
    if len(suffix) >= 180:
        raise AgentPrintDispatchIneligible("artifact file name is too long")
    return f"{base[: 180 - len(suffix)]}{suffix}"


def _require_https_presigned_url(value: str | None) -> None:
    if not isinstance(value, str):
        raise AgentPrintDispatchIneligible("storage must provide an HTTPS presigned artifact URL")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise AgentPrintDispatchIneligible("storage must provide an HTTPS presigned artifact URL")


def _require_start_payload_shape(
    job: BambuCloudJob,
    payload: Mapping[str, Any],
) -> None:
    fields = (
        {"remote_id", "file_name"}
        if _is_moonraker_job(job)
        else {"remote_id", "file_name", "options"}
    )
    _require_exact_fields(payload, fields, "start command")
    _required_remote_id(payload.get("remote_id"))
    _required_plain_file_name(payload.get("file_name"))
    if not _is_moonraker_job(job) and not isinstance(payload.get("options"), Mapping):
        raise AgentPrintDispatchError("start command options must be an object")


def _require_exact_fields(value: Mapping[str, Any], fields: set[str], name: str) -> None:
    if not isinstance(value, Mapping) or set(value) != fields:
        raise AgentPrintDispatchError(f"{name} fields do not match the protocol")


def _required_remote_id(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise AgentPrintDispatchError("remote_id is invalid")
    normalized = value.strip()
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts or "\\" in normalized or not path.name:
        raise AgentPrintDispatchError("remote_id is invalid")
    return normalized


def _required_plain_file_name(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise AgentPrintDispatchError("file_name is invalid")
    normalized = value.strip()
    if Path(normalized).name != normalized or len(normalized) > 180:
        raise AgentPrintDispatchError("file_name is invalid")
    return normalized


def _required_nonnegative_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise AgentPrintDispatchError(f"{field} must be a non-negative integer")
    return value


def _required_sha256(value: object) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise AgentPrintDispatchError("sha256 is invalid")
    return value


def _require_job_provider(job: BambuCloudJob, value: object) -> None:
    expected = "moonraker" if _is_moonraker_job(job) else "bambu"
    if value != expected:
        raise AgentPrintDispatchError(
            f"agent result provider does not match {expected} job"
        )


def _optional_bool(value: object, field: str, *, default: bool) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise AgentPrintDispatchError(f"{field} must be boolean")
    return value


def _validated_ams_mapping(value: object) -> list[int]:
    if (
        not isinstance(value, list)
        or len(value) > 16
        or any(
            not isinstance(slot, int)
            or isinstance(slot, bool)
            or not -1 <= slot <= 255
            for slot in value
        )
    ):
        raise AgentPrintDispatchError("ams_mapping is invalid")
    return list(value)


def _aware(value: datetime) -> datetime:
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
