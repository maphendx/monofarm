"""Durable protocol-v2 command execution on the farm edge."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

try:
    from .edge_runtime.journal import (
        CommandConflict,
        CommandState,
        EventRecord,
        SQLiteCommandJournal,
    )
except ImportError:  # source-script / PyInstaller execution from agent directory
    from edge_runtime.journal import (
        CommandConflict,
        CommandState,
        EventRecord,
        SQLiteCommandJournal,
    )


SUPPORTED_COMMAND_TYPES = frozenset(
    {
        "printer.status",
        "printer.upload",
        "printer.start",
        "printer.pause",
        "printer.resume",
        "printer.cancel",
        "printer.snapshot",
        "printer.reconcile",
    }
)
_WIRE_FIELDS = frozenset(
    {
        "id",
        "agent_device_id",
        "printer_id",
        "command_type",
        "payload",
        "payload_sha256",
        "state",
        "attempt",
        "deadline_at",
        "lease_expires_at",
    }
)
_MILESTONE_ORDER = {"delivered": 1, "printer_ack": 2, "terminal": 3}


class InvalidCommandEnvelope(ValueError):
    pass


class CommandNeedsReconcile(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class LeasedAgentCommand:
    command_id: str
    agent_device_id: str
    printer_id: int | None
    command_type: str
    payload: dict[str, Any]
    payload_sha256: str
    attempt: int
    deadline_at: datetime
    lease_expires_at: datetime

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> LeasedAgentCommand:
        if set(value) != _WIRE_FIELDS:
            raise InvalidCommandEnvelope("command envelope fields do not match protocol v2")
        try:
            command_id = str(UUID(str(value["id"])))
            device_id = str(UUID(str(value["agent_device_id"])))
            printer_id = value["printer_id"]
            if printer_id is not None and (not isinstance(printer_id, int) or printer_id < 1):
                raise ValueError("invalid printer_id")
            command_type = str(value["command_type"])
            if command_type not in SUPPORTED_COMMAND_TYPES:
                raise ValueError("unknown command_type")
            payload = value["payload"]
            if not isinstance(payload, dict):
                raise ValueError("payload must be an object")
            digest = str(value["payload_sha256"])
            actual_digest = canonical_payload_sha256(payload)
            if digest != actual_digest:
                raise InvalidCommandEnvelope("command payload digest mismatch")
            if value["state"] != "leased":
                raise ValueError("command is not leased")
            attempt = value["attempt"]
            if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
                raise ValueError("invalid command attempt")
            deadline = _wire_datetime(value["deadline_at"], "deadline_at")
            lease_expires = _wire_datetime(value["lease_expires_at"], "lease_expires_at")
        except InvalidCommandEnvelope:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidCommandEnvelope(f"invalid command envelope: {exc}") from exc
        return cls(
            command_id=command_id,
            agent_device_id=device_id,
            printer_id=printer_id,
            command_type=command_type,
            payload=dict(payload),
            payload_sha256=digest,
            attempt=attempt,
            deadline_at=deadline,
            lease_expires_at=lease_expires,
        )


@dataclass(frozen=True, slots=True)
class CommandExecutionResult:
    payload: dict[str, Any]
    milestones: tuple[str, ...] = ("terminal",)

    def __post_init__(self) -> None:
        previous = 0
        for state in self.milestones:
            order = _MILESTONE_ORDER.get(state)
            if order is None or order <= previous:
                raise ValueError("command milestones are invalid or out of order")
            previous = order
        if not self.milestones or self.milestones[-1] != "terminal":
            raise ValueError("command milestones must end in terminal")


CommandHandler = Callable[[dict[str, Any]], Awaitable[CommandExecutionResult]]
CommandAcknowledger = Callable[[str, str, int, str | None], Awaitable[None]]


def canonical_payload_sha256(payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        dict(payload),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


async def execute_leased_command(
    command: LeasedAgentCommand,
    *,
    journal: SQLiteCommandJournal,
    handler: CommandHandler,
    acknowledge: CommandAcknowledger,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> None:
    """Persist before side effects and replay stored outcomes idempotently."""

    if command.deadline_at <= now().astimezone(timezone.utc):
        await acknowledge(command.command_id, "failed", command.attempt, "deadline_expired")
        return
    try:
        record = journal.enqueue(command.command_id, command.command_type, command.payload)
    except CommandConflict as exc:
        await acknowledge(command.command_id, "failed", command.attempt, str(exc))
        return

    await acknowledge(command.command_id, "accepted", command.attempt, None)
    if record.state is CommandState.SUCCEEDED:
        await acknowledge(command.command_id, "executing", command.attempt, None)
        stored = record.result or {}
        for state in stored.get("_ack_states", ["terminal"]):
            await acknowledge(command.command_id, state, command.attempt, None)
        return
    if record.state in {CommandState.NEEDS_RECONCILE, CommandState.RECONCILING}:
        await acknowledge(
            command.command_id,
            "needs_reconcile",
            command.attempt,
            record.last_error or "local reconciliation required",
        )
        return
    if record.state is CommandState.FAILED:
        await acknowledge(
            command.command_id,
            "failed",
            command.attempt,
            record.last_error or "local command failed",
        )
        return
    if record.state is not CommandState.PENDING:
        await acknowledge(
            command.command_id,
            "needs_reconcile",
            command.attempt,
            "local command is already executing",
        )
        return

    await acknowledge(command.command_id, "executing", command.attempt, None)
    journal.claim(command.command_id)
    try:
        result = await handler(command.payload)
    except CommandNeedsReconcile as exc:
        journal.mark_failed(command.command_id, str(exc), retryable=True)
        await acknowledge(command.command_id, "needs_reconcile", command.attempt, str(exc))
        return
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        journal.mark_failed(command.command_id, error, retryable=False)
        await acknowledge(command.command_id, "failed", command.attempt, error)
        return

    stored_result = {"payload": dict(result.payload), "_ack_states": list(result.milestones)}
    journal.mark_succeeded(command.command_id, stored_result)
    for state in result.milestones:
        await acknowledge(command.command_id, state, command.attempt, None)


def build_event_batch(
    device_id: str,
    event_stream_id: str,
    events: Sequence[EventRecord],
) -> dict[str, Any]:
    return {
        "agent_device_id": device_id,
        "event_stream_id": event_stream_id,
        "events": [
            {
                "sequence": event.sequence,
                "command_id": event.command_id,
                "event_type": event.event_type,
                "payload": event.payload,
                "occurred_at_device": datetime.fromtimestamp(
                    event.occurred_at,
                    tz=timezone.utc,
                ).isoformat(),
            }
            for event in events
        ],
    }


def _wire_datetime(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include timezone")
    return parsed.astimezone(timezone.utc)
