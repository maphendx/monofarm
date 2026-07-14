from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.agent import AgentCommandState, AgentDevice
from app.models.organization import Organization
from app.models.printer import Printer
from app.models.user import User, UserRole
from app.schemas.agent import (
    AgentDeviceOut,
    AgentDevicePairingCreate,
    AgentCommandAckRequest,
    AgentCommandAckResponse,
    AgentCommandCreate,
    AgentCommandOut,
    AgentCommandPullRequest,
    AgentCommandPullResponse,
    AgentEventBatchIngest,
    AgentEventBatchResponse,
    AgentPairingCodeCreated,
    AgentPrinterAssignmentOut,
    AgentPrinterAssignmentUpdate,
    AgentPairRequest,
    AgentPairResult,
    AgentTokenRequest,
    AgentTokenResponse,
)
from app.services.agent_auth import (
    AGENT_ACCESS_TOKEN_TTL_SECONDS,
    AgentPrincipal,
    authenticate_device_secret,
    create_agent_access_token,
    generate_device_secret,
    generate_pairing_code,
    hash_agent_secret,
    require_agent_principal,
)
from app.services.agent_commands import (
    AgentCommandAttemptConflict,
    AgentCommandIdempotencyConflict,
    AgentCommandLeaseExpired,
    AgentCommandTargetNotFound,
    AgentCommandTargetUnavailable,
    AgentEventConflict,
    AgentPayloadDigestMismatch,
    InvalidAgentCommandTransition,
    acknowledge_agent_command,
    create_agent_command,
    ingest_agent_events,
    lease_pending_commands,
)


router = APIRouter(prefix="/agent", tags=["agent-v2"])


def _org_device(db: Session, organization_id: int, device_id: UUID) -> AgentDevice:
    device = (
        db.query(AgentDevice)
        .filter(
            AgentDevice.id == device_id,
            AgentDevice.organization_id == organization_id,
        )
        .first()
    )
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent device not found")
    return device


@router.post(
    "/devices/pairing-codes",
    response_model=AgentPairingCodeCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_pairing_code(
    payload: AgentDevicePairingCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin)),
) -> AgentPairingCodeCreated:
    raw_code = generate_pairing_code()
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=payload.expires_in_seconds)
    device = AgentDevice(
        organization_id=org.id,
        created_by_user_id=user.id,
        site_id=payload.site_id,
        name=payload.name,
        scopes=payload.scopes,
        pairing_code_hash=hash_agent_secret(raw_code),
        pairing_expires_at=expires_at,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return AgentPairingCodeCreated(device=AgentDeviceOut.model_validate(device), pairing_code=raw_code, expires_at=expires_at)


@router.get("/devices", response_model=list[AgentDeviceOut])
def list_devices(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> list[AgentDevice]:
    return (
        db.query(AgentDevice)
        .filter(AgentDevice.organization_id == org.id)
        .order_by(AgentDevice.created_at.desc(), AgentDevice.id.desc())
        .all()
    )


@router.get("/devices/{device_id}", response_model=AgentDeviceOut)
def get_device(
    device_id: UUID,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> AgentDevice:
    return _org_device(db, org.id, device_id)


def _printer_assignment(db: Session, organization_id: int, device_id: UUID) -> AgentPrinterAssignmentOut:
    printer_ids = [
        row[0]
        for row in db.query(Printer.id)
        .filter(
            Printer.organization_id == organization_id,
            Printer.agent_device_id == device_id,
        )
        .order_by(Printer.id.asc())
        .all()
    ]
    return AgentPrinterAssignmentOut(device_id=device_id, printer_ids=printer_ids)


@router.get("/devices/{device_id}/printers", response_model=AgentPrinterAssignmentOut)
def get_device_printers(
    device_id: UUID,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> AgentPrinterAssignmentOut:
    _org_device(db, org.id, device_id)
    return _printer_assignment(db, org.id, device_id)


@router.put("/devices/{device_id}/printers", response_model=AgentPrinterAssignmentOut)
def replace_device_printers(
    device_id: UUID,
    payload: AgentPrinterAssignmentUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> AgentPrinterAssignmentOut:
    _org_device(db, org.id, device_id)
    printers = (
        db.query(Printer)
        .filter(
            Printer.organization_id == org.id,
            Printer.id.in_(payload.printer_ids),
        )
        .all()
        if payload.printer_ids
        else []
    )
    if len(printers) != len(payload.printer_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")

    db.query(Printer).filter(
        Printer.organization_id == org.id,
        Printer.agent_device_id == device_id,
    ).update({Printer.agent_device_id: None}, synchronize_session=False)
    for printer in printers:
        printer.agent_device_id = device_id
    db.commit()
    return _printer_assignment(db, org.id, device_id)


@router.post("/devices/{device_id}/revoke", response_model=AgentDeviceOut)
def revoke_device(
    device_id: UUID,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> AgentDevice:
    device = _org_device(db, org.id, device_id)
    if device.revoked_at is None:
        device.revoked_at = datetime.now(timezone.utc)
        device.credential_version += 1
        device.credential_hash = None
        device.pairing_code_hash = None
        device.pairing_expires_at = None
        db.commit()
        db.refresh(device)
    return device


@router.post("/v2/pair", response_model=AgentPairResult, status_code=status.HTTP_201_CREATED)
def pair_device(payload: AgentPairRequest, db: Session = Depends(get_db)) -> AgentPairResult:
    device = (
        db.query(AgentDevice)
        .filter(AgentDevice.pairing_code_hash == hash_agent_secret(payload.pairing_code))
        .with_for_update()
        .first()
    )
    now = datetime.now(timezone.utc)
    expires_at = device.pairing_expires_at if device else None
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if (
        device is None
        or device.revoked_at is not None
        or device.paired_at is not None
        or expires_at is None
        or expires_at <= now
    ):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Pairing code is invalid, expired, or already used")

    raw_secret = generate_device_secret()
    device.public_key = payload.public_key
    device.capabilities = list(dict.fromkeys(payload.capabilities))
    device.credential_hash = hash_agent_secret(raw_secret)
    device.paired_at = now
    device.pairing_code_hash = None
    device.pairing_expires_at = None
    db.commit()
    db.refresh(device)

    access_token = create_agent_access_token(
        device_id=device.id,
        organization_id=device.organization_id,
        scopes=device.scopes,
        credential_version=device.credential_version,
    )
    return AgentPairResult(
        device_id=device.id,
        device_secret=raw_secret,
        access_token=access_token,
        expires_in=AGENT_ACCESS_TOKEN_TTL_SECONDS,
    )


@router.post("/v2/token", response_model=AgentTokenResponse)
def mint_agent_token(payload: AgentTokenRequest, db: Session = Depends(get_db)) -> AgentTokenResponse:
    device = authenticate_device_secret(db, payload.device_id, payload.device_secret)
    if device is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid agent credential")
    return AgentTokenResponse(
        access_token=create_agent_access_token(
            device_id=device.id,
            organization_id=device.organization_id,
            scopes=device.scopes,
            credential_version=device.credential_version,
        ),
        expires_in=AGENT_ACCESS_TOKEN_TTL_SECONDS,
    )


@router.post("/commands", response_model=AgentCommandOut, status_code=status.HTTP_201_CREATED)
def create_command(
    payload: AgentCommandCreate,
    response: Response,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> object:
    try:
        command, created = create_agent_command(
            db,
            organization_id=org.id,
            agent_device_id=payload.agent_device_id,
            printer_id=payload.printer_id,
            command_type=payload.command_type.value,
            payload=payload.payload,
            supplied_payload_sha256=payload.payload_sha256,
            idempotency_key=payload.idempotency_key,
            deadline_at=payload.deadline_at,
        )
    except AgentCommandTargetNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except AgentCommandTargetUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except AgentPayloadDigestMismatch as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except AgentCommandIdempotencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if not created:
        response.status_code = status.HTTP_200_OK
    return command


@router.post("/v2/commands/pull", response_model=AgentCommandPullResponse)
def pull_commands(
    payload: AgentCommandPullRequest,
    db: Session = Depends(get_db),
    principal: AgentPrincipal = Depends(require_agent_principal("commands:read")),
) -> AgentCommandPullResponse:
    commands, server_time = lease_pending_commands(
        db,
        device=principal.device,
        limit=payload.limit,
        lease_seconds=payload.lease_seconds,
    )
    return AgentCommandPullResponse(commands=commands, server_time=server_time)


@router.post("/v2/commands/{command_id}/ack", response_model=AgentCommandAckResponse)
def acknowledge_command(
    command_id: UUID,
    payload: AgentCommandAckRequest,
    db: Session = Depends(get_db),
    principal: AgentPrincipal = Depends(require_agent_principal("events:write")),
) -> AgentCommandAckResponse:
    try:
        command = acknowledge_agent_command(
            db,
            device=principal.device,
            command_id=command_id,
            target_state=AgentCommandState(payload.state.value),
            attempt=payload.attempt,
            last_error=payload.last_error,
        )
    except AgentCommandTargetNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except (
        AgentCommandAttemptConflict,
        AgentCommandLeaseExpired,
        InvalidAgentCommandTransition,
    ) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return AgentCommandAckResponse(
        command_id=command.id,
        state=command.state,
        attempt=command.attempt,
        updated_at=command.updated_at,
    )


@router.post("/v2/events/batch", response_model=AgentEventBatchResponse)
def ingest_events(
    payload: AgentEventBatchIngest,
    db: Session = Depends(get_db),
    principal: AgentPrincipal = Depends(require_agent_principal("events:write")),
) -> AgentEventBatchResponse:
    if payload.agent_device_id != principal.device.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Event batch device does not match authenticated agent",
        )
    try:
        result = ingest_agent_events(
            db,
            device=principal.device,
            event_stream_id=payload.event_stream_id,
            events=payload.events,
        )
    except AgentCommandTargetNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except AgentEventConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return AgentEventBatchResponse(
        accepted_count=result.accepted_count,
        duplicate_count=result.duplicate_count,
        highest_accepted_sequence=result.highest_accepted_sequence,
        highest_contiguous_sequence=result.highest_contiguous_sequence,
    )
