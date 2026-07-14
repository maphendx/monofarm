"""Bounded protocol-v2 command polling with durable edge execution."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

import httpx

try:
    from .command_runtime import (
        CommandExecutionResult,
        LeasedAgentCommand,
        build_event_batch,
        execute_leased_command,
    )
    from .edge_runtime.journal import SQLiteCommandJournal
except ImportError:  # source-script / PyInstaller execution from agent directory
    from command_runtime import (
        CommandExecutionResult,
        LeasedAgentCommand,
        build_event_batch,
        execute_leased_command,
    )
    from edge_runtime.journal import SQLiteCommandJournal


logger = logging.getLogger(__name__)

_PULL_PATH = "/api/agent/v2/commands/pull"
_EVENTS_PATH = "/api/agent/v2/events/batch"
_PULL_RESPONSE_FIELDS = frozenset({"commands", "server_time"})
_EVENT_RESPONSE_FIELDS = frozenset(
    {
        "accepted_count",
        "duplicate_count",
        "highest_accepted_sequence",
        "highest_contiguous_sequence",
    }
)
_ACTIVE_ACK_STATES = frozenset(
    {"accepted", "executing", "delivered", "printer_ack"}
)
_CONTROL_LANE_COMMANDS = frozenset(
    {
        "printer.status",
        "printer.pause",
        "printer.resume",
        "printer.cancel",
        "printer.snapshot",
    }
)
_TRANSFER_COMMANDS = frozenset({"printer.upload"})
_COMMAND_REPLAY_WINDOW = 1000


class AgentTokenProvider(Protocol):
    async def get(
        self,
        client: httpx.AsyncClient,
        *,
        force_refresh: bool = False,
    ) -> str: ...


CommandHandler = Callable[[LeasedAgentCommand], Awaitable[CommandExecutionResult]]
HttpClientFactory = Callable[[], httpx.AsyncClient]


class AgentProtocolError(ValueError):
    """Cloud response does not match the protocol-v2 contract."""


class DeviceCommandMismatch(AgentProtocolError):
    """A leased command was addressed to another physical agent."""


class ProtocolV2CommandWorker:
    """Poll, persist, execute, acknowledge, and export events in strict order.

    The journal and an injected client remain caller-owned. A client created by
    ``client_factory`` (or the default factory) is closed when ``run`` exits or
    ``close`` is called.
    """

    def __init__(
        self,
        *,
        server: str,
        device_id: str,
        journal: SQLiteCommandJournal,
        token_provider: AgentTokenProvider,
        handler: CommandHandler,
        client: httpx.AsyncClient | None = None,
        client_factory: HttpClientFactory | None = None,
        pull_batch_size: int = 1,
        lease_seconds: int = 30,
        lease_heartbeat_interval: float | None = None,
        outbox_batch_size: int = 100,
        max_in_flight: int = 20,
        transfer_concurrency: int = 2,
        poll_interval: float = 1.0,
        request_timeout: float = 30.0,
    ) -> None:
        if not server.strip():
            raise ValueError("server must not be blank")
        if client is not None and client_factory is not None:
            raise ValueError("provide client or client_factory, not both")
        _require_range("pull_batch_size", pull_batch_size, minimum=1, maximum=50)
        _require_range("lease_seconds", lease_seconds, minimum=5, maximum=300)
        if lease_heartbeat_interval is None:
            lease_heartbeat_interval = min(60.0, lease_seconds / 3)
        _require_range(
            "lease_heartbeat_interval",
            lease_heartbeat_interval,
            minimum=0.01,
            maximum=120.0,
        )
        if lease_heartbeat_interval >= lease_seconds:
            raise ValueError("lease_heartbeat_interval must be shorter than lease_seconds")
        _require_range("outbox_batch_size", outbox_batch_size, minimum=1, maximum=100)
        _require_range("max_in_flight", max_in_flight, minimum=1, maximum=50)
        _require_range(
            "transfer_concurrency",
            transfer_concurrency,
            minimum=1,
            maximum=8,
        )
        _require_range("poll_interval", poll_interval, minimum=0.01, maximum=60.0)
        _require_range("request_timeout", request_timeout, minimum=1.0, maximum=120.0)

        try:
            canonical_device_id = str(UUID(device_id))
        except (TypeError, ValueError, AttributeError) as exc:
            raise ValueError("device_id must be a UUID") from exc

        self.server = server.rstrip("/")
        self.device_id = canonical_device_id
        self.journal = journal
        self.token_provider = token_provider
        self.handler = handler
        self.pull_batch_size = pull_batch_size
        self.lease_seconds = lease_seconds
        self.lease_heartbeat_interval = float(lease_heartbeat_interval)
        self.outbox_batch_size = outbox_batch_size
        self.max_in_flight = max_in_flight
        self.poll_interval = float(poll_interval)
        self.request_timeout = float(request_timeout)

        self._client = client
        self._client_factory = client_factory
        self._owns_client = client is None
        self._started = False
        self._closed = False
        self._start_lock = asyncio.Lock()
        self._cycle_lock = asyncio.Lock()
        self._outbox_lock = asyncio.Lock()
        self._lane_locks: dict[tuple[int | None, str], asyncio.Lock] = {}
        self._transfer_slots = asyncio.Semaphore(transfer_concurrency)
        self._active_commands: dict[str, asyncio.Task[None]] = {}

    async def start(self) -> None:
        """Recover interrupted journal state before any cloud request."""

        if self._closed:
            raise RuntimeError("command worker is closed")
        if self._started:
            return
        async with self._start_lock:
            if self._started:
                return
            self.journal.recover_incomplete()
            self._ensure_client()
            self._started = True

    async def run_once(self) -> int:
        """Run one bounded outbox/pull/execute/outbox cycle."""

        await self.start()
        async with self._cycle_lock:
            await self.flush_outbox()
            commands = await self._pull_commands(
                limit=min(self.pull_batch_size, self.max_in_flight)
            )
            tasks = [self._schedule_command(command) for command in commands]
            if tasks:
                await asyncio.gather(*tasks)
            await self.flush_outbox()
            return len(commands)

    async def run(self) -> None:
        """Run until cancelled; transient failures remain eligible for retry."""

        await self.start()
        try:
            while True:
                try:
                    async with self._cycle_lock:
                        await self.flush_outbox()
                        capacity = self.max_in_flight - len(self._active_commands)
                        if capacity > 0:
                            commands = await self._pull_commands(
                                limit=min(self.pull_batch_size, capacity)
                            )
                            for command in commands:
                                self._schedule_command(command)
                        await self.flush_outbox()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Protocol-v2 command cycle failed")
                await asyncio.sleep(self.poll_interval)
        finally:
            await self._cancel_active_commands()
            await self.close()

    async def flush_outbox(self) -> int:
        """Send the oldest monotonic batch and delete only server-confirmed events."""

        await self.start()
        async with self._outbox_lock:
            events = self.journal.pending_outbox(limit=self.outbox_batch_size)
            if not events:
                return 0

            response = await self._post_authenticated(
                _EVENTS_PATH,
                build_event_batch(
                    self.device_id,
                    self.journal.event_stream_id,
                    events,
                ),
            )
            payload = _json_object(response, expected_fields=_EVENT_RESPONSE_FIELDS)
            highest_contiguous = _strict_nonnegative_int(
                payload.get("highest_contiguous_sequence"),
                "highest_contiguous_sequence",
            )
            _strict_nonnegative_int(payload.get("accepted_count"), "accepted_count")
            _strict_nonnegative_int(payload.get("duplicate_count"), "duplicate_count")
            _strict_nonnegative_int(
                payload.get("highest_accepted_sequence"),
                "highest_accepted_sequence",
            )

            if highest_contiguous == 0:
                return 0
            if not self.journal.list_events(
                after_sequence=highest_contiguous - 1,
                limit=1,
            ):
                raise AgentProtocolError(
                    "highest_contiguous_sequence exceeds the local event sequence"
                )
            deleted = self.journal.ack_outbox(through_sequence=highest_contiguous)
            self.journal.prune_terminal_commands(keep_recent=_COMMAND_REPLAY_WINDOW)
            return deleted

    async def close(self) -> None:
        """Idempotently close a worker-owned HTTP client."""

        if self._closed:
            return
        self._closed = True
        client = self._client
        self._client = None
        if self._owns_client and client is not None:
            await client.aclose()

    async def _pull_commands(self, *, limit: int | None = None) -> list[LeasedAgentCommand]:
        requested_limit = limit or self.pull_batch_size
        response = await self._post_authenticated(
            _PULL_PATH,
            {
                "limit": requested_limit,
                "lease_seconds": self.lease_seconds,
            },
        )
        payload = _json_object(response, expected_fields=_PULL_RESPONSE_FIELDS)
        commands = payload.get("commands")
        if not isinstance(commands, list):
            raise AgentProtocolError("pull response commands must be a list")
        if len(commands) > requested_limit:
            raise AgentProtocolError("pull response exceeds the requested command batch")
        _aware_timestamp(payload.get("server_time"), "server_time")

        parsed: list[LeasedAgentCommand] = []
        for item in commands:
            if not isinstance(item, Mapping):
                raise AgentProtocolError("leased command must be an object")
            command = LeasedAgentCommand.from_wire(item)
            if command.agent_device_id != self.device_id:
                raise DeviceCommandMismatch(
                    f"command {command.command_id} targets another agent device"
                )
            parsed.append(command)
        return parsed

    def _schedule_command(
        self,
        command: LeasedAgentCommand,
    ) -> asyncio.Task[None]:
        existing = self._active_commands.get(command.command_id)
        if existing is not None:
            return existing

        task = asyncio.create_task(self._execute_in_lane(command))
        self._active_commands[command.command_id] = task
        task.add_done_callback(
            lambda completed, command_id=command.command_id: self._command_finished(
                command_id,
                completed,
            )
        )
        return task

    async def _execute_in_lane(self, command: LeasedAgentCommand) -> None:
        lane = "control" if command.command_type in _CONTROL_LANE_COMMANDS else "ordered"
        lock = self._lane_locks.setdefault((command.printer_id, lane), asyncio.Lock())

        async def lane_handler(
            leased_command: LeasedAgentCommand,
        ) -> CommandExecutionResult:
            async with lock:
                if leased_command.command_type in _TRANSFER_COMMANDS:
                    async with self._transfer_slots:
                        return await self.handler(leased_command)
                return await self.handler(leased_command)

        await self._execute_command(command, handler=lane_handler)

    def _command_finished(
        self,
        command_id: str,
        task: asyncio.Task[None],
    ) -> None:
        if self._active_commands.get(command_id) is task:
            self._active_commands.pop(command_id, None)
        if task.cancelled():
            return
        try:
            task.result()
        except Exception:
            logger.exception(
                "Protocol-v2 command execution failed for %s",
                command_id,
            )

    async def _cancel_active_commands(self) -> None:
        tasks = list(self._active_commands.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._active_commands.clear()

    async def _execute_command(
        self,
        command: LeasedAgentCommand,
        *,
        handler: CommandHandler | None = None,
    ) -> None:
        ack_lock = asyncio.Lock()
        current_ack_state: str | None = None

        async def handle_persisted_payload(_payload: dict[str, Any]) -> CommandExecutionResult:
            return await (handler or self.handler)(command)

        async def post_ack(
            command_id: str,
            state: str,
            attempt: int,
            last_error: str | None,
        ) -> None:
            body: dict[str, Any] = {"state": state, "attempt": attempt}
            if last_error is not None:
                body["last_error"] = last_error[:4096]
            await self._post_authenticated(
                f"/api/agent/v2/commands/{command_id}/ack",
                body,
            )

        async def acknowledge(
            command_id: str,
            state: str,
            attempt: int,
            last_error: str | None,
        ) -> None:
            nonlocal current_ack_state
            async with ack_lock:
                await post_ack(command_id, state, attempt, last_error)
                current_ack_state = state

        execution_task = asyncio.create_task(
            execute_leased_command(
                command,
                journal=self.journal,
                handler=handle_persisted_payload,
                acknowledge=acknowledge,
            )
        )
        try:
            while not execution_task.done():
                done, _pending = await asyncio.wait(
                    {execution_task},
                    timeout=self.lease_heartbeat_interval,
                )
                if done:
                    break
                try:
                    async with ack_lock:
                        if (
                            execution_task.done()
                            or current_ack_state not in _ACTIVE_ACK_STATES
                        ):
                            continue
                        await post_ack(
                            command.command_id,
                            current_ack_state,
                            command.attempt,
                            None,
                        )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception(
                        "Protocol-v2 lease heartbeat failed for command %s",
                        command.command_id,
                    )
            await execution_task
        finally:
            if not execution_task.done():
                execution_task.cancel()
                await asyncio.gather(execution_task, return_exceptions=True)

    async def _post_authenticated(
        self,
        path: str,
        payload: Mapping[str, Any],
    ) -> httpx.Response:
        client = self._ensure_client()
        token = await self.token_provider.get(client)
        response = await client.post(
            f"{self.server}{path}",
            headers={"Authorization": f"Bearer {token}"},
            json=dict(payload),
            follow_redirects=False,
        )
        if response.status_code == 401:
            token = await self.token_provider.get(client, force_refresh=True)
            response = await client.post(
                f"{self.server}{path}",
                headers={"Authorization": f"Bearer {token}"},
                json=dict(payload),
                follow_redirects=False,
            )
        response.raise_for_status()
        return response

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._closed:
            raise RuntimeError("command worker is closed")
        if self._client is None:
            factory = self._client_factory
            self._client = (
                factory()
                if factory is not None
                else httpx.AsyncClient(
                    timeout=httpx.Timeout(self.request_timeout),
                    follow_redirects=False,
                )
            )
        return self._client


def _require_range(name: str, value: int | float, *, minimum: float, maximum: float) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")


def _json_object(
    response: httpx.Response,
    *,
    expected_fields: frozenset[str],
) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise AgentProtocolError("cloud response is not valid JSON") from exc
    if not isinstance(payload, dict) or set(payload) != expected_fields:
        raise AgentProtocolError("cloud response fields do not match protocol v2")
    return payload


def _strict_nonnegative_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise AgentProtocolError(f"{field} must be a non-negative integer")
    return value


def _aware_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise AgentProtocolError(f"{field} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AgentProtocolError(f"{field} must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        raise AgentProtocolError(f"{field} must include timezone")
    return parsed
