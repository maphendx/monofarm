from pathlib import Path
from uuid import UUID

import pytest

from agent.edge_runtime.journal import (
    CommandConflict,
    CommandState,
    ReconciliationOutcome,
    SQLiteCommandJournal,
)


def test_enqueue_replays_same_command_id_without_duplicate_execution(tmp_path: Path) -> None:
    journal = SQLiteCommandJournal(tmp_path / "commands.sqlite3")
    first = journal.enqueue(
        command_id="command-1",
        command_type="upload",
        payload={"file": "part.gcode", "priority": 2},
    )
    claimed = journal.claim_next()
    assert claimed is not None
    completed = journal.mark_succeeded("command-1", {"remote_id": "remote-1"})

    replayed = journal.enqueue(
        command_id="command-1",
        command_type="upload",
        payload={"priority": 2, "file": "part.gcode"},
    )

    assert first.state is CommandState.PENDING
    assert claimed.state is CommandState.EXECUTING
    assert completed.state is CommandState.SUCCEEDED
    assert replayed.state is CommandState.SUCCEEDED
    assert replayed.result == {"remote_id": "remote-1"}
    assert replayed.attempt == 1
    assert journal.claim_next() is None
    assert [event.event_type for event in journal.list_events()] == [
        "command.enqueued",
        "command.executing",
        "command.succeeded",
    ]
    journal.close()


def test_same_command_id_with_different_body_is_rejected(tmp_path: Path) -> None:
    with SQLiteCommandJournal(tmp_path / "commands.sqlite3") as journal:
        journal.enqueue("command-1", "upload", {"file": "one.gcode"})

        with pytest.raises(CommandConflict, match="command-1"):
            journal.enqueue("command-1", "upload", {"file": "two.gcode"})

        with pytest.raises(CommandConflict, match="command-1"):
            journal.enqueue("command-1", "start", {"file": "one.gcode"})


def test_restart_recovers_retryable_inflight_command_and_replays_outbox_in_sequence(
    tmp_path: Path,
) -> None:
    database = tmp_path / "commands.sqlite3"
    first_process = SQLiteCommandJournal(database)
    first_process.enqueue("command-1", "upload", {"remote_id": "remote-1"})
    first_claim = first_process.claim_next()
    assert first_claim is not None
    assert first_claim.attempt == 1
    first_process.close()

    with SQLiteCommandJournal(database) as restarted:
        assert restarted.recover_incomplete() == 1

        replayed_claim = restarted.claim_next()
        assert replayed_claim is not None
        assert replayed_claim.command_id == "command-1"
        assert replayed_claim.attempt == 2
        restarted.mark_succeeded("command-1", {"printer_reference": "task-7"})
        transfer_event = restarted.append_event(
            "command-1",
            "transfer.printer_ack",
            {"printer_reference": "task-7"},
        )

        events = restarted.list_events()
        sequences = [event.sequence for event in events]
        assert sequences == sorted(sequences)
        assert len(sequences) == len(set(sequences))
        assert [event.event_type for event in events] == [
            "command.enqueued",
            "command.executing",
            "command.recovered",
            "command.executing",
            "command.succeeded",
            "transfer.printer_ack",
        ]
        assert transfer_event.sequence == sequences[-1]

        assert [event.sequence for event in restarted.pending_outbox(limit=100)] == sequences
        assert restarted.ack_outbox(through_sequence=sequences[2]) == 3
        assert [event.sequence for event in restarted.pending_outbox(limit=100)] == sequences[3:]

    with SQLiteCommandJournal(database) as third_process:
        persisted = third_process.get("command-1")
        assert persisted is not None
        assert persisted.state is CommandState.SUCCEEDED
        assert persisted.result == {"printer_reference": "task-7"}
        assert third_process.recover_incomplete() == 0
        assert third_process.claim_next() is None
        assert [event.sequence for event in third_process.pending_outbox(limit=100)] == sequences[3:]


def test_acknowledged_events_are_deleted_without_resetting_sequence(tmp_path: Path) -> None:
    database = tmp_path / "commands.sqlite3"
    with SQLiteCommandJournal(database) as journal:
        journal.append_event(None, "agent.first", {})
        second = journal.append_event(None, "agent.second", {})
        third = journal.append_event(None, "agent.third", {})

        assert journal.ack_outbox(through_sequence=second.sequence) == 2
        assert [event.sequence for event in journal.list_events()] == [third.sequence]
        fourth = journal.append_event(None, "agent.fourth", {})
        assert fourth.sequence == third.sequence + 1

    with SQLiteCommandJournal(database) as restarted:
        fifth = restarted.append_event(None, "agent.fifth", {})

    assert fifth.sequence == fourth.sequence + 1


def test_event_stream_id_survives_restart_and_rotates_with_recreated_journal(
    tmp_path: Path,
) -> None:
    database = tmp_path / "commands.sqlite3"
    with SQLiteCommandJournal(database) as first_process:
        first_stream_id = first_process.event_stream_id
        UUID(first_stream_id)
        assert first_process.append_event(None, "agent.first", {}).sequence == 1

    with SQLiteCommandJournal(database) as restarted:
        assert restarted.event_stream_id == first_stream_id

    database.unlink()
    with SQLiteCommandJournal(database) as recreated:
        assert recreated.event_stream_id != first_stream_id
        UUID(recreated.event_stream_id)
        assert recreated.append_event(None, "agent.first", {}).sequence == 1


def test_terminal_command_pruning_keeps_recent_replay_window(tmp_path: Path) -> None:
    with SQLiteCommandJournal(tmp_path / "commands.sqlite3") as journal:
        command_ids = [f"command-{index}" for index in range(5)]
        for command_id in command_ids:
            journal.enqueue(command_id, "printer.status", {})
            journal.claim(command_id)
            journal.mark_succeeded(command_id, {"state": "idle"})

        last_sequence = journal.list_events()[-1].sequence
        journal.ack_outbox(through_sequence=last_sequence)
        assert journal.prune_terminal_commands(keep_recent=2) == 3

        assert [journal.get(command_id) is not None for command_id in command_ids] == [
            False,
            False,
            False,
            True,
            True,
        ]


@pytest.mark.parametrize("command_type", ["start", "print_start", "printer.start"])
def test_restart_during_start_requires_reconciliation_before_normal_replay(
    tmp_path: Path,
    command_type: str,
) -> None:
    database = tmp_path / "commands.sqlite3"
    first_process = SQLiteCommandJournal(database)
    first_process.enqueue("command-1", command_type, {"remote_id": "remote-1"})
    first_claim = first_process.claim_next()
    assert first_claim is not None
    assert first_claim.attempt == 1
    first_process.close()

    with SQLiteCommandJournal(database) as restarted:
        assert restarted.recover_incomplete() == 1

        interrupted = restarted.get("command-1")
        assert interrupted is not None
        assert interrupted.state is CommandState.NEEDS_RECONCILE
        assert interrupted.attempt == 1
        assert restarted.claim_next() is None

        reconciliation = restarted.claim_next_reconciliation()
        assert reconciliation is not None
        assert reconciliation.command_id == "command-1"
        assert reconciliation.state is CommandState.RECONCILING
        assert reconciliation.attempt == 1
        assert restarted.claim_next() is None

        resolved = restarted.resolve_reconciliation(
            "command-1",
            ReconciliationOutcome.CONFIRMED_SUCCEEDED,
            result={"printer_reference": "task-7"},
        )
        assert resolved.state is CommandState.SUCCEEDED
        assert resolved.result == {"printer_reference": "task-7"}
        assert restarted.claim_next() is None

        events = restarted.list_events()
        sequences = [event.sequence for event in events]
        assert sequences == sorted(sequences)
        assert len(sequences) == len(set(sequences))
        assert [event.event_type for event in events] == [
            "command.enqueued",
            "command.executing",
            "command.needs_reconcile",
            "command.reconciling",
            "command.reconciliation_resolved",
        ]


def test_claim_targets_exact_persisted_command(tmp_path: Path) -> None:
    with SQLiteCommandJournal(tmp_path / "commands.sqlite3") as journal:
        journal.enqueue("command-1", "printer.status", {})
        journal.enqueue("command-2", "printer.pause", {})

        claimed = journal.claim("command-2")

        assert claimed.command_id == "command-2"
        assert claimed.state is CommandState.EXECUTING
        assert journal.get("command-1").state is CommandState.PENDING


def test_reconciliation_allows_normal_retry_only_after_confirmed_not_started(
    tmp_path: Path,
) -> None:
    with SQLiteCommandJournal(tmp_path / "commands.sqlite3") as journal:
        journal.enqueue("command-1", "start", {"remote_id": "remote-1"})
        assert journal.claim_next() is not None
        assert journal.recover_incomplete() == 1
        assert journal.claim_next() is None
        assert journal.claim_next_reconciliation() is not None

        resolved = journal.resolve_reconciliation(
            "command-1",
            ReconciliationOutcome.CONFIRMED_NOT_STARTED,
        )
        retry = journal.claim_next()

        assert resolved.state is CommandState.PENDING
        assert retry is not None
        assert retry.state is CommandState.EXECUTING
        assert retry.attempt == 2
        assert [event.event_type for event in journal.list_events()][-3:] == [
            "command.reconciling",
            "command.reconciliation_resolved",
            "command.executing",
        ]


@pytest.mark.parametrize(
    ("outcome", "error", "expected_state"),
    [
        (ReconciliationOutcome.INCONCLUSIVE, "printer still offline", CommandState.NEEDS_RECONCILE),
        (ReconciliationOutcome.TERMINAL_FAILURE, "printer rejected job", CommandState.FAILED),
    ],
)
def test_reconciliation_inconclusive_or_failure_never_enters_normal_replay(
    tmp_path: Path,
    outcome: ReconciliationOutcome,
    error: str,
    expected_state: CommandState,
) -> None:
    with SQLiteCommandJournal(tmp_path / "commands.sqlite3") as journal:
        journal.enqueue("command-1", "start", {"remote_id": "remote-1"})
        assert journal.claim_next() is not None
        assert journal.recover_incomplete() == 1
        assert journal.claim_next_reconciliation() is not None

        resolved = journal.resolve_reconciliation("command-1", outcome, error=error)

        assert resolved.state is expected_state
        assert resolved.last_error == error
        assert journal.claim_next() is None


def test_restart_during_reconciliation_returns_to_reconciliation_queue(tmp_path: Path) -> None:
    database = tmp_path / "commands.sqlite3"
    first_process = SQLiteCommandJournal(database)
    first_process.enqueue("command-1", "start", {"remote_id": "remote-1"})
    assert first_process.claim_next() is not None
    assert first_process.recover_incomplete() == 1
    assert first_process.claim_next_reconciliation() is not None
    first_process.close()

    with SQLiteCommandJournal(database) as restarted:
        assert restarted.recover_incomplete() == 1
        command = restarted.get("command-1")

        assert command is not None
        assert command.state is CommandState.NEEDS_RECONCILE
        assert restarted.claim_next() is None
        assert [event.event_type for event in restarted.list_events()][-1] == (
            "command.needs_reconcile"
        )


def test_retryable_failure_returns_command_to_pending(tmp_path: Path) -> None:
    with SQLiteCommandJournal(tmp_path / "commands.sqlite3") as journal:
        journal.enqueue("command-1", "upload", {})
        assert journal.claim_next() is not None

        retry = journal.mark_failed("command-1", "printer offline", retryable=True)
        second_claim = journal.claim_next()

        assert retry.state is CommandState.PENDING
        assert second_claim is not None
        assert second_claim.attempt == 2
        assert [event.event_type for event in journal.list_events()][-2:] == [
            "command.retry_scheduled",
            "command.executing",
        ]


def test_retryable_start_failure_requires_reconciliation_instead_of_replay(
    tmp_path: Path,
) -> None:
    with SQLiteCommandJournal(tmp_path / "commands.sqlite3") as journal:
        journal.enqueue("command-1", "start", {"remote_id": "remote-1"})
        assert journal.claim_next() is not None

        deferred = journal.mark_failed("command-1", "start ACK timed out", retryable=True)

        assert deferred.state is CommandState.NEEDS_RECONCILE
        assert deferred.last_error == "start ACK timed out"
        assert journal.claim_next() is None
        assert journal.claim_next_reconciliation() is not None
        assert [event.event_type for event in journal.list_events()][-2:] == [
            "command.needs_reconcile",
            "command.reconciling",
        ]
