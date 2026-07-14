import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from agent.command_runtime import (
    CommandExecutionResult,
    CommandNeedsReconcile,
    InvalidCommandEnvelope,
    LeasedAgentCommand,
    build_event_batch,
    execute_leased_command,
)
from agent.edge_runtime.journal import CommandState, SQLiteCommandJournal


def _wire(command_id: str, command_type: str, payload: dict) -> dict:
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {
        "id": command_id,
        "agent_device_id": "019f0000-0000-7000-8000-000000000001",
        "printer_id": 7,
        "command_type": command_type,
        "payload": payload,
        "payload_sha256": digest,
        "state": "leased",
        "attempt": 1,
        "deadline_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        "lease_expires_at": (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(),
    }


def test_duplicate_cloud_delivery_runs_side_effect_once(tmp_path: Path) -> None:
    journal = SQLiteCommandJournal(tmp_path / "runtime.sqlite3")
    command = LeasedAgentCommand.from_wire(
        _wire("019f0000-0000-7000-8000-000000000010", "printer.pause", {"provider": "bambu"})
    )
    calls = 0
    acknowledgements: list[str] = []

    async def handler(_payload: dict) -> CommandExecutionResult:
        nonlocal calls
        calls += 1
        return CommandExecutionResult({"paused": True})

    async def ack(_command_id: str, state: str, _attempt: int, _error: str | None) -> None:
        acknowledgements.append(state)

    async def exercise() -> None:
        await execute_leased_command(command, journal=journal, handler=handler, acknowledge=ack)
        await execute_leased_command(command, journal=journal, handler=handler, acknowledge=ack)

    asyncio.run(exercise())

    assert calls == 1
    assert journal.get(command.command_id).state is CommandState.SUCCEEDED
    assert acknowledgements == [
        "accepted",
        "executing",
        "terminal",
        "accepted",
        "executing",
        "terminal",
    ]


def test_ambiguous_start_is_quarantined_for_reconcile_not_replayed(tmp_path: Path) -> None:
    journal = SQLiteCommandJournal(tmp_path / "runtime.sqlite3")
    command = LeasedAgentCommand.from_wire(
        _wire("019f0000-0000-7000-8000-000000000011", "printer.start", {"remote_id": "part.gcode"})
    )
    calls = 0
    acknowledgements: list[tuple[str, str | None]] = []

    async def handler(_payload: dict) -> CommandExecutionResult:
        nonlocal calls
        calls += 1
        raise CommandNeedsReconcile("start ACK was lost")

    async def ack(_command_id: str, state: str, _attempt: int, error: str | None) -> None:
        acknowledgements.append((state, error))

    async def exercise() -> None:
        await execute_leased_command(command, journal=journal, handler=handler, acknowledge=ack)
        await execute_leased_command(command, journal=journal, handler=handler, acknowledge=ack)

    asyncio.run(exercise())

    assert calls == 1
    assert journal.get(command.command_id).state is CommandState.NEEDS_RECONCILE
    assert acknowledgements[-1] == ("needs_reconcile", "start ACK was lost")


def test_executing_ack_failure_does_not_strand_local_command(tmp_path: Path) -> None:
    journal = SQLiteCommandJournal(tmp_path / "runtime.sqlite3")
    command = LeasedAgentCommand.from_wire(
        _wire(
            "019f0000-0000-7000-8000-000000000014",
            "printer.pause",
            {"provider": "bambu"},
        )
    )
    handler_calls = 0
    fail_executing_ack = True

    async def handler(_payload: dict) -> CommandExecutionResult:
        nonlocal handler_calls
        handler_calls += 1
        return CommandExecutionResult({"paused": True})

    async def ack(
        _command_id: str,
        state: str,
        _attempt: int,
        _error: str | None,
    ) -> None:
        nonlocal fail_executing_ack
        if state == "executing" and fail_executing_ack:
            fail_executing_ack = False
            raise ConnectionError("cloud ACK unavailable")

    async def exercise() -> None:
        with pytest.raises(ConnectionError, match="ACK unavailable"):
            await execute_leased_command(
                command,
                journal=journal,
                handler=handler,
                acknowledge=ack,
            )
        assert journal.get(command.command_id).state is CommandState.PENDING

        await execute_leased_command(
            command,
            journal=journal,
            handler=handler,
            acknowledge=ack,
        )

    asyncio.run(exercise())

    assert handler_calls == 1
    assert journal.get(command.command_id).state is CommandState.SUCCEEDED


def test_envelope_rejects_payload_tampering_and_unknown_fields() -> None:
    tampered = _wire(
        "019f0000-0000-7000-8000-000000000012",
        "printer.status",
        {"provider": "moonraker"},
    )
    tampered["payload"] = {"provider": "evil"}
    with pytest.raises(InvalidCommandEnvelope, match="digest"):
        LeasedAgentCommand.from_wire(tampered)

    unknown = _wire(
        "019f0000-0000-7000-8000-000000000013",
        "printer.status",
        {},
    )
    unknown["arbitrary_url"] = "http://169.254.169.254"
    with pytest.raises(InvalidCommandEnvelope, match="fields"):
        LeasedAgentCommand.from_wire(unknown)


def test_event_batch_preserves_monotonic_outbox_sequence(tmp_path: Path) -> None:
    with SQLiteCommandJournal(tmp_path / "runtime.sqlite3") as journal:
        journal.enqueue("command-1", "printer.status", {})
        journal.append_event("command-1", "printer.snapshot", {"state": "idle"})

        events = journal.pending_outbox(limit=100)
        payload = build_event_batch(
            "019f0000-0000-7000-8000-000000000001",
            journal.event_stream_id,
            events,
        )

        assert payload["event_stream_id"] == journal.event_stream_id
        assert [item["sequence"] for item in payload["events"]] == [1, 2]
        assert payload["events"][0]["command_id"] == "command-1"
        assert payload["events"][0]["occurred_at_device"].endswith("+00:00")
