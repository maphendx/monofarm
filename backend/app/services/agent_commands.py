from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import and_, or_
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.agent import AgentCommand, AgentCommandState, AgentDevice, AgentEvent
from app.models.printer import Printer
from app.schemas.agent import AgentEventIngestItem
from app.services.agent_routing import device_can_access_printer


DEADLINE_EXPIRED_ERROR = "deadline_expired"
ACTIVE_COMMAND_LEASE_SECONDS = 300

_ACTIVE_COMMAND_STATES = frozenset(
    {
        AgentCommandState.accepted,
        AgentCommandState.executing,
        AgentCommandState.delivered,
        AgentCommandState.printer_ack,
    }
)
_RECOVERABLE_LEASE_STATES = frozenset(
    {AgentCommandState.leased, *_ACTIVE_COMMAND_STATES}
)


class AgentCommandServiceError(ValueError):
    pass


class AgentCommandTargetNotFound(AgentCommandServiceError):
    pass


class AgentCommandTargetUnavailable(AgentCommandServiceError):
    pass


class AgentCommandIdempotencyConflict(AgentCommandServiceError):
    pass


class AgentPayloadDigestMismatch(AgentCommandServiceError):
    pass


class InvalidAgentCommandTransition(AgentCommandServiceError):
    pass


class AgentCommandAttemptConflict(AgentCommandServiceError):
    pass


class AgentCommandLeaseExpired(AgentCommandServiceError):
    pass


class AgentEventConflict(AgentCommandServiceError):
    pass


@dataclass(frozen=True)
class AgentEventIngestResult:
    accepted_count: int
    duplicate_count: int
    highest_accepted_sequence: int
    highest_contiguous_sequence: int


_ALLOWED_AGENT_TRANSITIONS: dict[AgentCommandState, frozenset[AgentCommandState]] = {
    AgentCommandState.queued: frozenset(),
    AgentCommandState.leased: frozenset(
        {
            AgentCommandState.accepted,
            AgentCommandState.needs_reconcile,
            AgentCommandState.failed,
        }
    ),
    AgentCommandState.accepted: frozenset(
        {
            AgentCommandState.executing,
            AgentCommandState.needs_reconcile,
            AgentCommandState.failed,
        }
    ),
    AgentCommandState.executing: frozenset(
        {
            AgentCommandState.delivered,
            AgentCommandState.printer_ack,
            AgentCommandState.terminal,
            AgentCommandState.needs_reconcile,
            AgentCommandState.failed,
        }
    ),
    AgentCommandState.delivered: frozenset(
        {
            AgentCommandState.printer_ack,
            AgentCommandState.terminal,
            AgentCommandState.needs_reconcile,
            AgentCommandState.failed,
        }
    ),
    AgentCommandState.printer_ack: frozenset(
        {
            AgentCommandState.terminal,
            AgentCommandState.needs_reconcile,
            AgentCommandState.failed,
        }
    ),
    AgentCommandState.needs_reconcile: frozenset(
        {
            AgentCommandState.executing,
            AgentCommandState.printer_ack,
            AgentCommandState.terminal,
            AgentCommandState.failed,
        }
    ),
    AgentCommandState.terminal: frozenset(),
    AgentCommandState.failed: frozenset(),
}


def canonical_payload_sha256(payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(dict(payload), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_agent_command_transition(
    current: AgentCommandState,
    target: AgentCommandState,
) -> bool:
    if current is target:
        return False
    if target not in _ALLOWED_AGENT_TRANSITIONS[current]:
        raise InvalidAgentCommandTransition(f"cannot transition command from {current.value} to {target.value}")
    return True


def highest_contiguous_sequence(sequences: Iterable[int]) -> int:
    expected = 1
    for sequence in sorted(set(sequences)):
        if sequence < expected:
            continue
        if sequence != expected:
            break
        expected += 1
    return expected - 1


def create_agent_command(
    db: Session,
    *,
    organization_id: int,
    agent_device_id: UUID,
    printer_id: int | None,
    command_type: str,
    payload: dict[str, Any],
    supplied_payload_sha256: str | None,
    idempotency_key: str,
    deadline_at: datetime,
) -> tuple[AgentCommand, bool]:
    device = (
        db.query(AgentDevice)
        .filter(
            AgentDevice.id == agent_device_id,
            AgentDevice.organization_id == organization_id,
        )
        .first()
    )
    if device is None:
        raise AgentCommandTargetNotFound("Agent device not found")
    if device.revoked_at is not None or not device.is_paired:
        raise AgentCommandTargetUnavailable("Agent device is not available")

    if printer_id is not None:
        printer = (
            db.query(Printer)
            .filter(Printer.id == printer_id, Printer.organization_id == organization_id)
            .first()
        )
        if printer is None:
            raise AgentCommandTargetNotFound("Printer not found")
        if not device_can_access_printer(db, device, printer):
            raise AgentCommandTargetUnavailable("Printer is not assigned to this agent device")

    digest = canonical_payload_sha256(payload)
    if supplied_payload_sha256 is not None and supplied_payload_sha256 != digest:
        raise AgentPayloadDigestMismatch("payload_sha256 does not match payload")

    existing = _command_by_idempotency(db, organization_id, idempotency_key)
    if existing is not None:
        if not _same_command_request(
            existing,
            agent_device_id=agent_device_id,
            printer_id=printer_id,
            command_type=command_type,
            payload_sha256=digest,
            deadline_at=deadline_at,
        ):
            raise AgentCommandIdempotencyConflict("Idempotency key was already used for another command")
        return existing, False

    command = AgentCommand(
        organization_id=organization_id,
        agent_device_id=agent_device_id,
        printer_id=printer_id,
        command_type=command_type,
        payload_json=payload,
        payload_sha256=digest,
        idempotency_key=idempotency_key,
        state=AgentCommandState.queued,
        deadline_at=deadline_at,
    )
    db.add(command)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = _command_by_idempotency(db, organization_id, idempotency_key)
        if existing is None or not _same_command_request(
            existing,
            agent_device_id=agent_device_id,
            printer_id=printer_id,
            command_type=command_type,
            payload_sha256=digest,
            deadline_at=deadline_at,
        ):
            raise AgentCommandIdempotencyConflict(
                "Idempotency key was concurrently used for another command"
            ) from None
        return existing, False
    db.refresh(command)
    return command, True


def lease_pending_commands(
    db: Session,
    *,
    device: AgentDevice,
    limit: int,
    lease_seconds: int,
    now: datetime | None = None,
) -> tuple[list[AgentCommand], datetime]:
    current_time = now or datetime.now(timezone.utc)
    expirable = (
        db.query(AgentCommand)
        .filter(
            AgentCommand.organization_id == device.organization_id,
            AgentCommand.agent_device_id == device.id,
            AgentCommand.state.in_(
                [AgentCommandState.queued, *_RECOVERABLE_LEASE_STATES]
            ),
            AgentCommand.deadline_at <= current_time,
        )
        .with_for_update(skip_locked=True)
        .all()
    )
    for command in expirable:
        command.state = AgentCommandState.failed
        command.last_error = DEADLINE_EXPIRED_ERROR
        command.lease_owner = None
        command.lease_expires_at = None

    commands = (
        db.query(AgentCommand)
        .filter(
            AgentCommand.organization_id == device.organization_id,
            AgentCommand.agent_device_id == device.id,
            AgentCommand.deadline_at > current_time,
            or_(
                AgentCommand.state == AgentCommandState.queued,
                and_(
                    AgentCommand.state.in_(_RECOVERABLE_LEASE_STATES),
                    or_(
                        AgentCommand.lease_expires_at.is_(None),
                        AgentCommand.lease_expires_at <= current_time,
                    ),
                ),
            ),
        )
        .order_by(AgentCommand.created_at.asc(), AgentCommand.id.asc())
        .with_for_update(skip_locked=True)
        .limit(limit)
        .all()
    )
    for command in commands:
        command.state = AgentCommandState.leased
        command.attempt += 1
        command.lease_owner = str(device.id)
        command.lease_expires_at = min(
            current_time + timedelta(seconds=lease_seconds),
            _as_utc(command.deadline_at),
        )
        command.last_error = None
    db.commit()
    for command in commands:
        db.refresh(command)
    return commands, current_time


def acknowledge_agent_command(
    db: Session,
    *,
    device: AgentDevice,
    command_id: UUID,
    target_state: AgentCommandState,
    attempt: int,
    last_error: str | None,
    now: datetime | None = None,
) -> AgentCommand:
    command = (
        db.query(AgentCommand)
        .filter(
            AgentCommand.id == command_id,
            AgentCommand.organization_id == device.organization_id,
            AgentCommand.agent_device_id == device.id,
        )
        .with_for_update()
        .first()
    )
    if command is None:
        raise AgentCommandTargetNotFound("Command not found")
    if command.attempt != attempt:
        raise AgentCommandAttemptConflict(
            f"Command attempt is {command.attempt}, received stale attempt {attempt}"
        )

    current_time = now or datetime.now(timezone.utc)
    if command.state is AgentCommandState.leased:
        lease_expires_at = command.lease_expires_at
        if lease_expires_at is None or _as_utc(lease_expires_at) <= current_time:
            raise AgentCommandLeaseExpired("Command lease expired")
    if _as_utc(command.deadline_at) <= current_time and target_state not in {
        AgentCommandState.terminal,
        AgentCommandState.needs_reconcile,
        AgentCommandState.failed,
    }:
        raise AgentCommandLeaseExpired("Command deadline expired")

    changed = validate_agent_command_transition(command.state, target_state)
    if not changed:
        if command.last_error != last_error:
            raise InvalidAgentCommandTransition("Repeated command state has conflicting last_error")
        _refresh_active_command_lease(command, device, target_state, current_time)
        db.commit()
        db.refresh(command)
        return command

    command.state = target_state
    command.last_error = last_error
    if target_state in _ACTIVE_COMMAND_STATES:
        _refresh_active_command_lease(command, device, target_state, current_time)
    else:
        command.lease_owner = None
        command.lease_expires_at = None
    db.commit()
    db.refresh(command)
    return command


def _refresh_active_command_lease(
    command: AgentCommand,
    device: AgentDevice,
    state: AgentCommandState,
    now: datetime,
) -> None:
    if state not in _ACTIVE_COMMAND_STATES:
        return
    command.lease_owner = str(device.id)
    command.lease_expires_at = min(
        now + timedelta(seconds=ACTIVE_COMMAND_LEASE_SECONDS),
        _as_utc(command.deadline_at),
    )


def ingest_agent_events(
    db: Session,
    *,
    device: AgentDevice,
    event_stream_id: UUID,
    events: Sequence[AgentEventIngestItem],
) -> AgentEventIngestResult:
    printer_ids = {event.printer_id for event in events if event.printer_id is not None}
    valid_printer_ids = (
        {
            row[0]
            for row in db.query(Printer.id)
            .filter(
                Printer.organization_id == device.organization_id,
                Printer.id.in_(printer_ids),
            )
            .all()
        }
        if printer_ids
        else set()
    )
    missing_printers = printer_ids - valid_printer_ids
    if missing_printers:
        raise AgentCommandTargetNotFound("Event printer not found")

    command_ids = {event.command_id for event in events if event.command_id is not None}
    commands = {
        command.id: command
        for command in (
            db.query(AgentCommand)
            .filter(
                AgentCommand.organization_id == device.organization_id,
                AgentCommand.agent_device_id == device.id,
                AgentCommand.id.in_(command_ids),
            )
            .all()
            if command_ids
            else []
        )
    }
    if command_ids - set(commands):
        raise AgentCommandTargetNotFound("Event command not found")

    resolved_events: list[tuple[AgentEventIngestItem, int | None]] = []
    for event in events:
        command = commands.get(event.command_id) if event.command_id is not None else None
        if (
            command is not None
            and command.printer_id is not None
            and event.printer_id is not None
            and command.printer_id != event.printer_id
        ):
            raise AgentEventConflict("Event printer does not match command printer")
        effective_printer_id = event.printer_id or (command.printer_id if command else None)
        resolved_events.append((event, effective_printer_id))

    accepted_count = 0
    duplicate_count = 0
    with db.begin_nested():
        locked_device = (
            db.query(AgentDevice)
            .filter(
                AgentDevice.id == device.id,
                AgentDevice.organization_id == device.organization_id,
            )
            .populate_existing()
            .with_for_update()
            .one()
        )
        if locked_device.current_event_stream_id != event_stream_id:
            if events[0].sequence != 1:
                raise AgentEventConflict("A new event stream must start at sequence 1")
            retired_stream = (
                db.query(AgentEvent.id)
                .filter(
                    AgentEvent.organization_id == locked_device.organization_id,
                    AgentEvent.agent_device_id == locked_device.id,
                    AgentEvent.event_stream_id == event_stream_id,
                )
                .first()
            )
            if retired_stream is not None:
                raise AgentEventConflict("A retired event stream cannot be reactivated")
            locked_device.current_event_stream_id = event_stream_id
            locked_device.current_event_cursor = 0

        for event, effective_printer_id in resolved_events:
            statement = (
                postgresql_insert(AgentEvent)
                .values(
                    id=uuid.uuid4(),
                    organization_id=device.organization_id,
                    agent_device_id=device.id,
                    printer_id=effective_printer_id,
                    command_id=event.command_id,
                    event_stream_id=event_stream_id,
                    monotonic_sequence=event.sequence,
                    event_type=event.event_type,
                    payload_json=event.payload,
                    occurred_at_device=event.occurred_at_device,
                )
                .on_conflict_do_nothing(
                    index_elements=[
                        AgentEvent.agent_device_id,
                        AgentEvent.event_stream_id,
                        AgentEvent.monotonic_sequence,
                    ]
                )
                .returning(AgentEvent.id)
            )
            inserted_id = db.execute(statement).scalar_one_or_none()
            if inserted_id is not None:
                accepted_count += 1
                continue

            existing = (
                db.query(AgentEvent)
                .filter(
                    AgentEvent.organization_id == device.organization_id,
                    AgentEvent.agent_device_id == device.id,
                    AgentEvent.event_stream_id == event_stream_id,
                    AgentEvent.monotonic_sequence == event.sequence,
                )
                .first()
            )
            if existing is None or not _same_event(
                existing,
                event=event,
                effective_printer_id=effective_printer_id,
            ):
                raise AgentEventConflict(
                    f"Sequence {event.sequence} was already used for another event"
                )
            duplicate_count += 1

        cursor = locked_device.current_event_cursor
        contiguous_candidates = (
            db.query(AgentEvent.monotonic_sequence)
            .filter(
                AgentEvent.organization_id == locked_device.organization_id,
                AgentEvent.agent_device_id == locked_device.id,
                AgentEvent.event_stream_id == event_stream_id,
                AgentEvent.monotonic_sequence > cursor,
            )
            .order_by(AgentEvent.monotonic_sequence.asc())
            .limit(100)
            .all()
        )
        for (sequence,) in contiguous_candidates:
            if sequence == cursor + 1:
                cursor = sequence
            elif sequence > cursor + 1:
                break
        locked_device.current_event_cursor = cursor
        contiguous_cursor = cursor
    db.commit()

    # Durable command ACKs intentionally carry no provider result. The edge
    # journal exports upload/start outcomes through AgentEvent, so advance any
    # job-scoped orchestration only after the events are durably stored. A
    # failed processor leaves the event in Postgres; the agent retry can then
    # replay the same sequence and the job bridge remains idempotent.
    _process_agent_print_events(
        db,
        device=device,
        event_stream_id=event_stream_id,
        sequences=[event.sequence for event, _printer_id in resolved_events],
    )
    highest_accepted_sequence = (
        db.query(AgentEvent.monotonic_sequence)
        .filter(
            AgentEvent.organization_id == device.organization_id,
            AgentEvent.agent_device_id == device.id,
            AgentEvent.event_stream_id == event_stream_id,
        )
        .order_by(AgentEvent.monotonic_sequence.desc())
        .limit(1)
        .scalar()
        or 0
    )

    return AgentEventIngestResult(
        accepted_count=accepted_count,
        duplicate_count=duplicate_count,
        highest_accepted_sequence=highest_accepted_sequence,
        highest_contiguous_sequence=contiguous_cursor,
    )


def _process_agent_print_events(
    db: Session,
    *,
    device: AgentDevice,
    event_stream_id: UUID,
    sequences: Sequence[int],
) -> None:
    if not sequences:
        return
    from app.services.agent_print_dispatch import (
        AgentPrintDispatchError,
        process_agent_print_event,
        reject_agent_print_event,
    )

    persisted = (
        db.query(AgentEvent)
        .filter(
            AgentEvent.organization_id == device.organization_id,
            AgentEvent.agent_device_id == device.id,
            AgentEvent.event_stream_id == event_stream_id,
            AgentEvent.monotonic_sequence.in_(set(sequences)),
        )
        .order_by(AgentEvent.monotonic_sequence.asc())
        .all()
    )
    for event in persisted:
        try:
            process_agent_print_event(db, event)
        except AgentPrintDispatchError as exc:
            reject_agent_print_event(db, event, exc)


def _command_by_idempotency(
    db: Session,
    organization_id: int,
    idempotency_key: str,
) -> AgentCommand | None:
    return (
        db.query(AgentCommand)
        .filter(
            AgentCommand.organization_id == organization_id,
            AgentCommand.idempotency_key == idempotency_key,
        )
        .first()
    )


def _same_command_request(
    command: AgentCommand,
    *,
    agent_device_id: UUID,
    printer_id: int | None,
    command_type: str,
    payload_sha256: str,
    deadline_at: datetime,
) -> bool:
    return (
        command.agent_device_id == agent_device_id
        and command.printer_id == printer_id
        and command.command_type == command_type
        and command.payload_sha256 == payload_sha256
        and _as_utc(command.deadline_at) == _as_utc(deadline_at)
    )


def _same_event(
    existing: AgentEvent,
    *,
    event: AgentEventIngestItem,
    effective_printer_id: int | None,
) -> bool:
    return (
        existing.printer_id == effective_printer_id
        and existing.command_id == event.command_id
        and existing.event_type == event.event_type
        and existing.payload_json == event.payload
        and _as_utc(existing.occurred_at_device) == _as_utc(event.occurred_at_device)
    )


def _as_utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
