"""Durable SQLite command journal and monotonic event outbox."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any


class CommandState(str, Enum):
    PENDING = "pending"
    EXECUTING = "executing"
    NEEDS_RECONCILE = "needs_reconcile"
    RECONCILING = "reconciling"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class ReconciliationOutcome(str, Enum):
    CONFIRMED_SUCCEEDED = "confirmed_succeeded"
    CONFIRMED_NOT_STARTED = "confirmed_not_started"
    INCONCLUSIVE = "inconclusive"
    TERMINAL_FAILURE = "terminal_failure"


RECONCILIATION_REQUIRED_COMMAND_TYPES = frozenset(
    {"start", "print_start", "printer.start"}
)


class CommandConflict(RuntimeError):
    pass


class InvalidCommandTransition(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class CommandRecord:
    command_id: str
    command_type: str
    payload: dict[str, Any]
    state: CommandState
    attempt: int
    result: dict[str, Any] | None
    last_error: str | None
    created_at: float
    updated_at: float


@dataclass(frozen=True, slots=True)
class EventRecord:
    sequence: int
    command_id: str | None
    event_type: str
    payload: dict[str, Any]
    occurred_at: float
    acked_at: float | None


class SQLiteCommandJournal:
    """Persist commands and outbound events in one transactional SQLite file."""

    def __init__(self, path: str | Path, *, clock=time.time) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._clock = clock
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = sqlite3.connect(
            self.path,
            isolation_level=None,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        self._configure()
        self._create_schema()
        self._event_stream_id = self._load_or_create_event_stream_id()

    def __enter__(self) -> SQLiteCommandJournal:
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    @property
    def event_stream_id(self) -> str:
        """Stable identity for this journal's monotonic event sequence."""

        return self._event_stream_id

    def enqueue(
        self,
        command_id: str,
        command_type: str,
        payload: Mapping[str, Any],
    ) -> CommandRecord:
        payload_json = _encode_json(payload)
        with self._transaction():
            existing = self._connection_or_raise().execute(
                "SELECT * FROM commands WHERE command_id = ?",
                (command_id,),
            ).fetchone()
            if existing is not None:
                if existing["command_type"] != command_type or existing["payload_json"] != payload_json:
                    raise CommandConflict(f"command_id {command_id!r} was already used for another command")
                return _command_from_row(existing)

            now = self._clock()
            self._connection_or_raise().execute(
                """
                INSERT INTO commands (
                    command_id, command_type, payload_json, state, attempt,
                    result_json, last_error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)
                """,
                (command_id, command_type, payload_json, CommandState.PENDING.value, now, now),
            )
            self._append_event_unlocked(
                command_id,
                "command.enqueued",
                {"command_type": command_type},
                occurred_at=now,
            )
            return self._get_unlocked(command_id)

    def get(self, command_id: str) -> CommandRecord | None:
        with self._lock:
            row = self._connection_or_raise().execute(
                "SELECT * FROM commands WHERE command_id = ?",
                (command_id,),
            ).fetchone()
            return _command_from_row(row) if row is not None else None

    def claim_next(self) -> CommandRecord | None:
        with self._transaction():
            row = self._connection_or_raise().execute(
                """
                SELECT * FROM commands
                WHERE state = ?
                ORDER BY rowid
                LIMIT 1
                """,
                (CommandState.PENDING.value,),
            ).fetchone()
            if row is None:
                return None

            return self._claim_row_unlocked(row)

    def claim(self, command_id: str) -> CommandRecord:
        """Claim one exact pending command without depending on queue ordering."""
        with self._transaction():
            row = self._require_command_unlocked(command_id)
            state = CommandState(row["state"])
            if state is not CommandState.PENDING:
                raise InvalidCommandTransition(
                    f"cannot claim command {command_id!r} from {state.value}"
                )
            return self._claim_row_unlocked(row)

    def _claim_row_unlocked(self, row: sqlite3.Row) -> CommandRecord:
        now = self._clock()
        attempt = int(row["attempt"]) + 1
        self._connection_or_raise().execute(
            """
            UPDATE commands
            SET state = ?, attempt = ?, updated_at = ?
            WHERE command_id = ?
            """,
            (CommandState.EXECUTING.value, attempt, now, row["command_id"]),
        )
        self._append_event_unlocked(
            row["command_id"],
            "command.executing",
            {"attempt": attempt},
            occurred_at=now,
        )
        return self._get_unlocked(row["command_id"])

    def claim_next_reconciliation(self) -> CommandRecord | None:
        """Claim one ambiguous command without exposing it to normal execution."""

        with self._transaction():
            row = self._connection_or_raise().execute(
                """
                SELECT * FROM commands
                WHERE state = ?
                ORDER BY rowid
                LIMIT 1
                """,
                (CommandState.NEEDS_RECONCILE.value,),
            ).fetchone()
            if row is None:
                return None

            now = self._clock()
            self._connection_or_raise().execute(
                """
                UPDATE commands
                SET state = ?, updated_at = ?
                WHERE command_id = ?
                """,
                (CommandState.RECONCILING.value, now, row["command_id"]),
            )
            self._append_event_unlocked(
                row["command_id"],
                "command.reconciling",
                {"execution_attempt": int(row["attempt"])},
                occurred_at=now,
            )
            return self._get_unlocked(row["command_id"])

    def resolve_reconciliation(
        self,
        command_id: str,
        outcome: ReconciliationOutcome,
        *,
        result: Mapping[str, Any] | None = None,
        error: str | None = None,
    ) -> CommandRecord:
        """Resolve an explicit printer-state check without a blind start retry."""

        if outcome is ReconciliationOutcome.TERMINAL_FAILURE and not error:
            raise ValueError("terminal reconciliation failure requires an error")

        with self._transaction():
            row = self._require_command_unlocked(command_id)
            state = CommandState(row["state"])
            if state is not CommandState.RECONCILING:
                raise InvalidCommandTransition(
                    f"cannot resolve reconciliation for command {command_id!r} from {state.value}"
                )

            result_json: str | None = None
            last_error: str | None = None
            if outcome is ReconciliationOutcome.CONFIRMED_SUCCEEDED:
                next_state = CommandState.SUCCEEDED
                result_json = _encode_json(result or {})
            elif outcome is ReconciliationOutcome.CONFIRMED_NOT_STARTED:
                next_state = CommandState.PENDING
            elif outcome is ReconciliationOutcome.INCONCLUSIVE:
                next_state = CommandState.NEEDS_RECONCILE
                last_error = error
            elif outcome is ReconciliationOutcome.TERMINAL_FAILURE:
                next_state = CommandState.FAILED
                last_error = error
            else:
                raise ValueError(f"unsupported reconciliation outcome: {outcome!r}")

            now = self._clock()
            self._connection_or_raise().execute(
                """
                UPDATE commands
                SET state = ?, result_json = ?, last_error = ?, updated_at = ?
                WHERE command_id = ?
                """,
                (next_state.value, result_json, last_error, now, command_id),
            )
            event_payload: dict[str, Any] = {"outcome": outcome.value}
            if result is not None:
                event_payload["result"] = dict(result)
            if error is not None:
                event_payload["error"] = error
            self._append_event_unlocked(
                command_id,
                "command.reconciliation_resolved",
                event_payload,
                occurred_at=now,
            )
            return self._get_unlocked(command_id)

    def mark_succeeded(self, command_id: str, result: Mapping[str, Any]) -> CommandRecord:
        result_json = _encode_json(result)
        with self._transaction():
            row = self._require_command_unlocked(command_id)
            state = CommandState(row["state"])
            if state is CommandState.SUCCEEDED:
                if row["result_json"] != result_json:
                    raise CommandConflict(f"command_id {command_id!r} already has another result")
                return _command_from_row(row)
            if state is not CommandState.EXECUTING:
                raise InvalidCommandTransition(
                    f"cannot mark command {command_id!r} succeeded from {state.value}"
                )

            now = self._clock()
            self._connection_or_raise().execute(
                """
                UPDATE commands
                SET state = ?, result_json = ?, last_error = NULL, updated_at = ?
                WHERE command_id = ?
                """,
                (CommandState.SUCCEEDED.value, result_json, now, command_id),
            )
            self._append_event_unlocked(
                command_id,
                "command.succeeded",
                dict(result),
                occurred_at=now,
            )
            return self._get_unlocked(command_id)

    def mark_failed(self, command_id: str, error: str, *, retryable: bool = False) -> CommandRecord:
        with self._transaction():
            row = self._require_command_unlocked(command_id)
            state = CommandState(row["state"])
            if state is not CommandState.EXECUTING:
                raise InvalidCommandTransition(
                    f"cannot mark command {command_id!r} failed from {state.value}"
                )

            needs_reconcile = retryable and _requires_reconciliation(row["command_type"])
            if needs_reconcile:
                next_state = CommandState.NEEDS_RECONCILE
                event_type = "command.needs_reconcile"
            else:
                next_state = CommandState.PENDING if retryable else CommandState.FAILED
                event_type = "command.retry_scheduled" if retryable else "command.failed"
            now = self._clock()
            self._connection_or_raise().execute(
                """
                UPDATE commands
                SET state = ?, last_error = ?, updated_at = ?
                WHERE command_id = ?
                """,
                (next_state.value, error, now, command_id),
            )
            event_payload: dict[str, Any] = {
                "attempt": int(row["attempt"]),
                "error": error,
            }
            if needs_reconcile:
                event_payload["reason"] = "retryable_failure_after_start"
            self._append_event_unlocked(
                command_id,
                event_type,
                event_payload,
                occurred_at=now,
            )
            return self._get_unlocked(command_id)

    def recover_incomplete(self) -> int:
        """Recover interrupted work without blindly replaying physical starts."""

        with self._transaction():
            rows = self._connection_or_raise().execute(
                """
                SELECT * FROM commands
                WHERE state IN (?, ?)
                ORDER BY rowid
                """,
                (CommandState.EXECUTING.value, CommandState.RECONCILING.value),
            ).fetchall()
            now = self._clock()
            for row in rows:
                interrupted_reconciliation = row["state"] == CommandState.RECONCILING.value
                needs_reconcile = interrupted_reconciliation or _requires_reconciliation(
                    row["command_type"]
                )
                next_state = (
                    CommandState.NEEDS_RECONCILE if needs_reconcile else CommandState.PENDING
                )
                self._connection_or_raise().execute(
                    """
                    UPDATE commands
                    SET state = ?, updated_at = ?
                    WHERE command_id = ?
                    """,
                    (next_state.value, now, row["command_id"]),
                )
                event_type = "command.needs_reconcile" if needs_reconcile else "command.recovered"
                event_payload: dict[str, Any] = {"previous_attempt": int(row["attempt"])}
                if needs_reconcile:
                    event_payload["reason"] = (
                        "interrupted_reconciliation"
                        if interrupted_reconciliation
                        else "interrupted_start"
                    )
                self._append_event_unlocked(
                    row["command_id"],
                    event_type,
                    event_payload,
                    occurred_at=now,
                )
            return len(rows)

    def append_event(
        self,
        command_id: str | None,
        event_type: str,
        payload: Mapping[str, Any],
    ) -> EventRecord:
        with self._transaction():
            return self._append_event_unlocked(command_id, event_type, payload)

    def list_events(self, *, after_sequence: int = 0, limit: int | None = None) -> list[EventRecord]:
        query = "SELECT * FROM events WHERE sequence > ? ORDER BY sequence"
        parameters: list[Any] = [after_sequence]
        if limit is not None:
            query += " LIMIT ?"
            parameters.append(limit)
        with self._lock:
            rows = self._connection_or_raise().execute(query, parameters).fetchall()
            return [_event_from_row(row) for row in rows]

    def pending_outbox(self, *, limit: int) -> list[EventRecord]:
        with self._lock:
            rows = self._connection_or_raise().execute(
                """
                SELECT * FROM events
                WHERE acked_at IS NULL
                ORDER BY sequence
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [_event_from_row(row) for row in rows]

    def ack_outbox(self, *, through_sequence: int) -> int:
        with self._transaction():
            cursor = self._connection_or_raise().execute(
                """
                DELETE FROM events
                WHERE acked_at IS NULL AND sequence <= ?
                """,
                (through_sequence,),
            )
            return cursor.rowcount

    def prune_terminal_commands(self, *, keep_recent: int = 1000) -> int:
        """Bound replay history after all related outbox events are acknowledged."""

        if isinstance(keep_recent, bool) or not isinstance(keep_recent, int) or keep_recent < 0:
            raise ValueError("keep_recent must be a non-negative integer")
        with self._transaction():
            rows = self._connection_or_raise().execute(
                """
                SELECT command_id
                FROM commands
                WHERE state IN (?, ?)
                  AND NOT EXISTS (
                      SELECT 1 FROM events WHERE events.command_id = commands.command_id
                  )
                ORDER BY updated_at DESC, rowid DESC
                LIMIT -1 OFFSET ?
                """,
                (
                    CommandState.SUCCEEDED.value,
                    CommandState.FAILED.value,
                    keep_recent,
                ),
            ).fetchall()
            if not rows:
                return 0
            self._connection_or_raise().executemany(
                "DELETE FROM commands WHERE command_id = ?",
                [(row["command_id"],) for row in rows],
            )
            return len(rows)

    def _configure(self) -> None:
        connection = self._connection_or_raise()
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA foreign_keys = ON")

    def _create_schema(self) -> None:
        self._connection_or_raise().executescript(
            """
            CREATE TABLE IF NOT EXISTS commands (
                command_id TEXT PRIMARY KEY,
                command_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                state TEXT NOT NULL CHECK (
                    state IN (
                        'pending', 'executing', 'needs_reconcile', 'reconciling',
                        'succeeded', 'failed'
                    )
                ),
                attempt INTEGER NOT NULL DEFAULT 0,
                result_json TEXT,
                last_error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                command_id TEXT,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                occurred_at REAL NOT NULL,
                acked_at REAL,
                FOREIGN KEY (command_id) REFERENCES commands(command_id)
            );

            CREATE INDEX IF NOT EXISTS ix_events_pending
            ON events(acked_at, sequence);

            CREATE TABLE IF NOT EXISTS journal_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )

    def _load_or_create_event_stream_id(self) -> str:
        generated = str(uuid.uuid4())
        with self._transaction():
            connection = self._connection_or_raise()
            connection.execute(
                """
                INSERT OR IGNORE INTO journal_metadata (key, value)
                VALUES ('event_stream_id', ?)
                """,
                (generated,),
            )
            row = connection.execute(
                "SELECT value FROM journal_metadata WHERE key = 'event_stream_id'"
            ).fetchone()
        if row is None:
            raise RuntimeError("event stream identity was not persisted")
        try:
            return str(uuid.UUID(row["value"]))
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError("journal event_stream_id is invalid") from exc

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        with self._lock:
            connection = self._connection_or_raise()
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                connection.rollback()
                raise
            else:
                connection.commit()

    def _get_unlocked(self, command_id: str) -> CommandRecord:
        row = self._require_command_unlocked(command_id)
        return _command_from_row(row)

    def _require_command_unlocked(self, command_id: str) -> sqlite3.Row:
        row = self._connection_or_raise().execute(
            "SELECT * FROM commands WHERE command_id = ?",
            (command_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"unknown command_id {command_id!r}")
        return row

    def _append_event_unlocked(
        self,
        command_id: str | None,
        event_type: str,
        payload: Mapping[str, Any],
        *,
        occurred_at: float | None = None,
    ) -> EventRecord:
        cursor = self._connection_or_raise().execute(
            """
            INSERT INTO events (command_id, event_type, payload_json, occurred_at, acked_at)
            VALUES (?, ?, ?, ?, NULL)
            """,
            (command_id, event_type, _encode_json(payload), occurred_at or self._clock()),
        )
        row = self._connection_or_raise().execute(
            "SELECT * FROM events WHERE sequence = ?",
            (cursor.lastrowid,),
        ).fetchone()
        if row is None:
            raise RuntimeError("event insert did not return a row")
        return _event_from_row(row)

    def _connection_or_raise(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("journal is closed")
        return self._connection


def _encode_json(value: Mapping[str, Any]) -> str:
    return json.dumps(dict(value), ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _requires_reconciliation(command_type: str) -> bool:
    return command_type.strip().lower() in RECONCILIATION_REQUIRED_COMMAND_TYPES


def _decode_json(value: str | None) -> dict[str, Any] | None:
    if value is None:
        return None
    decoded = json.loads(value)
    if not isinstance(decoded, dict):
        raise ValueError("journal JSON value is not an object")
    return decoded


def _command_from_row(row: sqlite3.Row) -> CommandRecord:
    payload = _decode_json(row["payload_json"])
    if payload is None:
        raise ValueError("command payload cannot be null")
    return CommandRecord(
        command_id=row["command_id"],
        command_type=row["command_type"],
        payload=payload,
        state=CommandState(row["state"]),
        attempt=int(row["attempt"]),
        result=_decode_json(row["result_json"]),
        last_error=row["last_error"],
        created_at=float(row["created_at"]),
        updated_at=float(row["updated_at"]),
    )


def _event_from_row(row: sqlite3.Row) -> EventRecord:
    payload = _decode_json(row["payload_json"])
    if payload is None:
        raise ValueError("event payload cannot be null")
    return EventRecord(
        sequence=int(row["sequence"]),
        command_id=row["command_id"],
        event_type=row["event_type"],
        payload=payload,
        occurred_at=float(row["occurred_at"]),
        acked_at=float(row["acked_at"]) if row["acked_at"] is not None else None,
    )
