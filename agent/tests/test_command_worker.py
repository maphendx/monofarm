from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest

from agent.command_runtime import CommandExecutionResult
from agent.command_worker import (
    DeviceCommandMismatch,
    ProtocolV2CommandWorker,
)
from agent.edge_runtime.journal import CommandState, SQLiteCommandJournal


DEVICE_ID = "019f0000-0000-7000-8000-000000000001"
OTHER_DEVICE_ID = "019f0000-0000-7000-8000-000000000002"
COMMAND_ID = "019f0000-0000-7000-8000-000000000010"


class _TokenProvider:
    def __init__(self) -> None:
        self.force_refreshes: list[bool] = []

    async def get(
        self,
        _client: httpx.AsyncClient,
        *,
        force_refresh: bool = False,
    ) -> str:
        self.force_refreshes.append(force_refresh)
        return "fresh-token" if force_refresh else "cached-token"


def _wire_command(
    *,
    device_id: str = DEVICE_ID,
    command_id: str = COMMAND_ID,
    printer_id: int = 7,
    command_type: str = "printer.pause",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    command_payload = payload or {"provider": "bambu"}
    digest = hashlib.sha256(
        json.dumps(command_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    now = datetime.now(timezone.utc)
    return {
        "id": command_id,
        "agent_device_id": device_id,
        "printer_id": printer_id,
        "command_type": command_type,
        "payload": command_payload,
        "payload_sha256": digest,
        "state": "leased",
        "attempt": 1,
        "deadline_at": (now + timedelta(minutes=5)).isoformat(),
        "lease_expires_at": (now + timedelta(seconds=30)).isoformat(),
    }


def _json_response(request: httpx.Request, payload: dict[str, Any], status: int = 200):
    return httpx.Response(status, request=request, json=payload)


def _pull_response(commands: list[dict[str, Any]]) -> dict[str, Any]:
    return {"commands": commands, "server_time": datetime.now(timezone.utc).isoformat()}


def _event_response(highest_contiguous_sequence: int) -> dict[str, int]:
    return {
        "accepted_count": 1,
        "duplicate_count": 0,
        "highest_accepted_sequence": max(highest_contiguous_sequence, 1),
        "highest_contiguous_sequence": highest_contiguous_sequence,
    }


def test_successful_pull_persists_executes_acks_and_flushes_outbox(tmp_path: Path) -> None:
    calls: list[str] = []
    requests: list[httpx.Request] = []

    async def transport(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/commands/pull"):
            return _json_response(request, _pull_response([_wire_command()]))
        if request.url.path.endswith("/events/batch"):
            sequences = [event["sequence"] for event in json.loads(request.content)["events"]]
            return _json_response(request, _event_response(max(sequences)))
        return _json_response(
            request,
            {
                "command_id": COMMAND_ID,
                "state": "terminal",
                "attempt": 1,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )

    async def handler(command) -> CommandExecutionResult:
        calls.append(command.command_id)
        return CommandExecutionResult({"paused": True})

    async def exercise() -> tuple[SQLiteCommandJournal, ProtocolV2CommandWorker]:
        journal = SQLiteCommandJournal(tmp_path / "runtime.sqlite3")
        client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        worker = ProtocolV2CommandWorker(
            server="https://api.monofarm.app",
            device_id=DEVICE_ID,
            journal=journal,
            token_provider=_TokenProvider(),
            handler=handler,
            client=client,
        )
        await worker.run_once()
        await client.aclose()
        return journal, worker

    journal, _worker = asyncio.run(exercise())

    assert calls == [COMMAND_ID]
    assert journal.get(COMMAND_ID).state is CommandState.SUCCEEDED
    assert journal.pending_outbox(limit=100) == []
    assert [request.url.path for request in requests] == [
        "/api/agent/v2/commands/pull",
        f"/api/agent/v2/commands/{COMMAND_ID}/ack",
        f"/api/agent/v2/commands/{COMMAND_ID}/ack",
        f"/api/agent/v2/commands/{COMMAND_ID}/ack",
        "/api/agent/v2/events/batch",
    ]


def test_duplicate_delivery_replays_result_without_side_effect(tmp_path: Path) -> None:
    handler_calls = 0
    pull_count = 0

    async def transport(request: httpx.Request) -> httpx.Response:
        nonlocal pull_count
        if request.url.path.endswith("/commands/pull"):
            pull_count += 1
            return _json_response(request, _pull_response([_wire_command()]))
        if request.url.path.endswith("/events/batch"):
            events = json.loads(request.content)["events"]
            return _json_response(request, _event_response(events[-1]["sequence"]))
        return _json_response(request, {"ok": True})

    async def handler(_command) -> CommandExecutionResult:
        nonlocal handler_calls
        handler_calls += 1
        return CommandExecutionResult({"paused": True})

    async def exercise() -> None:
        with SQLiteCommandJournal(tmp_path / "runtime.sqlite3") as journal:
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                worker = ProtocolV2CommandWorker(
                    server="https://api.monofarm.app",
                    device_id=DEVICE_ID,
                    journal=journal,
                    token_provider=_TokenProvider(),
                    handler=handler,
                    client=client,
                )
                await worker.run_once()
                await worker.run_once()

    asyncio.run(exercise())

    assert pull_count == 2
    assert handler_calls == 1


def test_ack_401_forces_one_token_refresh_and_one_retry(tmp_path: Path) -> None:
    provider = _TokenProvider()
    accepted_attempts = 0

    async def transport(request: httpx.Request) -> httpx.Response:
        nonlocal accepted_attempts
        if request.url.path.endswith("/commands/pull"):
            return _json_response(request, _pull_response([_wire_command()]))
        if request.url.path.endswith("/events/batch"):
            events = json.loads(request.content)["events"]
            return _json_response(request, _event_response(events[-1]["sequence"]))
        body = json.loads(request.content)
        if body["state"] == "accepted":
            accepted_attempts += 1
            if accepted_attempts == 1:
                return _json_response(request, {"detail": "expired"}, status=401)
        return _json_response(request, {"ok": True})

    async def handler(_command) -> CommandExecutionResult:
        return CommandExecutionResult({"paused": True})

    async def exercise() -> None:
        with SQLiteCommandJournal(tmp_path / "runtime.sqlite3") as journal:
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                worker = ProtocolV2CommandWorker(
                    server="https://api.monofarm.app",
                    device_id=DEVICE_ID,
                    journal=journal,
                    token_provider=provider,
                    handler=handler,
                    client=client,
                )
                await worker.run_once()

    asyncio.run(exercise())

    assert accepted_attempts == 2
    assert provider.force_refreshes.count(True) == 1


def test_event_ack_uses_only_highest_contiguous_sequence(tmp_path: Path) -> None:
    responses = iter([0, 1])

    async def transport(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/events/batch")
        return _json_response(request, _event_response(next(responses)))

    async def exercise() -> tuple[int, int]:
        journal = SQLiteCommandJournal(tmp_path / "runtime.sqlite3")
        journal.append_event(None, "agent.first", {})
        journal.append_event(None, "agent.second", {})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            worker = ProtocolV2CommandWorker(
                server="https://api.monofarm.app",
                device_id=DEVICE_ID,
                journal=journal,
                token_provider=_TokenProvider(),
                handler=lambda _command: None,  # type: ignore[arg-type]
                client=client,
            )
            await worker.flush_outbox()
            after_gap = len(journal.pending_outbox(limit=100))
            await worker.flush_outbox()
            after_first = len(journal.pending_outbox(limit=100))
        journal.close()
        return after_gap, after_first

    assert asyncio.run(exercise()) == (2, 1)


def test_network_error_does_not_delete_outbox(tmp_path: Path) -> None:
    async def transport(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    async def exercise() -> int:
        journal = SQLiteCommandJournal(tmp_path / "runtime.sqlite3")
        journal.append_event(None, "agent.offline", {})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            worker = ProtocolV2CommandWorker(
                server="https://api.monofarm.app",
                device_id=DEVICE_ID,
                journal=journal,
                token_provider=_TokenProvider(),
                handler=lambda _command: None,  # type: ignore[arg-type]
                client=client,
            )
            with pytest.raises(httpx.ConnectError):
                await worker.flush_outbox()
            pending = len(journal.pending_outbox(limit=100))
        journal.close()
        return pending

    assert asyncio.run(exercise()) == 1


def test_mismatched_device_is_rejected_before_persistence_or_side_effect(
    tmp_path: Path,
) -> None:
    handler_calls = 0

    async def transport(request: httpx.Request) -> httpx.Response:
        return _json_response(
            request,
            _pull_response([_wire_command(device_id=OTHER_DEVICE_ID)]),
        )

    async def handler(_command) -> CommandExecutionResult:
        nonlocal handler_calls
        handler_calls += 1
        return CommandExecutionResult({})

    async def exercise() -> tuple[int, object | None]:
        journal = SQLiteCommandJournal(tmp_path / "runtime.sqlite3")
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            worker = ProtocolV2CommandWorker(
                server="https://api.monofarm.app",
                device_id=DEVICE_ID,
                journal=journal,
                token_provider=_TokenProvider(),
                handler=handler,
                client=client,
            )
            with pytest.raises(DeviceCommandMismatch):
                await worker.run_once()
            record = journal.get(COMMAND_ID)
        journal.close()
        return handler_calls, record

    assert asyncio.run(exercise()) == (0, None)


def test_server_cannot_exceed_requested_command_batch(tmp_path: Path) -> None:
    async def transport(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/events/batch"):
            events = json.loads(request.content)["events"]
            return _json_response(request, _event_response(events[-1]["sequence"]))
        if request.url.path.endswith("/ack"):
            return _json_response(request, {"ok": True})
        return _json_response(
            request,
            _pull_response(
                [
                    _wire_command(command_id=COMMAND_ID),
                    _wire_command(command_id="019f0000-0000-7000-8000-000000000011"),
                ]
            ),
        )

    async def handler(_command) -> CommandExecutionResult:
        raise AssertionError("oversized cloud batch must be rejected as one unit")

    async def exercise() -> None:
        with SQLiteCommandJournal(tmp_path / "runtime.sqlite3") as journal:
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                worker = ProtocolV2CommandWorker(
                    server="https://api.monofarm.app",
                    device_id=DEVICE_ID,
                    journal=journal,
                    token_provider=_TokenProvider(),
                    handler=handler,
                    client=client,
                    pull_batch_size=1,
                )
                with pytest.raises(ValueError, match="batch"):
                    await worker.run_once()
                assert journal.get(COMMAND_ID) is None

    asyncio.run(exercise())


def test_startup_recovers_interrupted_start_before_first_pull(tmp_path: Path) -> None:
    journal_path = tmp_path / "runtime.sqlite3"
    with SQLiteCommandJournal(journal_path) as journal:
        journal.enqueue(COMMAND_ID, "printer.start", {"remote_id": "part.3mf"})
        journal.claim(COMMAND_ID)

    observed_state: list[CommandState] = []
    request_order: list[str] = []

    async def transport(request: httpx.Request) -> httpx.Response:
        request_order.append(request.url.path)
        with SQLiteCommandJournal(journal_path) as observer:
            observed_state.append(observer.get(COMMAND_ID).state)
        if request.url.path.endswith("/events/batch"):
            events = json.loads(request.content)["events"]
            return _json_response(request, _event_response(events[-1]["sequence"]))
        return _json_response(request, _pull_response([]))

    async def handler(_command) -> CommandExecutionResult:
        raise AssertionError("recovered printer.start must not be blindly replayed")

    async def exercise() -> CommandState:
        journal = SQLiteCommandJournal(journal_path)
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            worker = ProtocolV2CommandWorker(
                server="https://api.monofarm.app",
                device_id=DEVICE_ID,
                journal=journal,
                token_provider=_TokenProvider(),
                handler=handler,
                client=client,
            )
            await worker.run_once()
        state = journal.get(COMMAND_ID).state
        journal.close()
        return state

    assert asyncio.run(exercise()) is CommandState.NEEDS_RECONCILE
    assert observed_state
    assert all(state is CommandState.NEEDS_RECONCILE for state in observed_state)
    assert request_order[0] == "/api/agent/v2/events/batch"


def test_long_running_command_renews_its_active_lease(tmp_path: Path) -> None:
    ack_states: list[str] = []

    async def transport(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/commands/pull"):
            return _json_response(request, _pull_response([_wire_command()]))
        if request.url.path.endswith("/events/batch"):
            events = json.loads(request.content)["events"]
            return _json_response(request, _event_response(events[-1]["sequence"]))
        ack_states.append(json.loads(request.content)["state"])
        return _json_response(request, {"ok": True})

    async def handler(_command) -> CommandExecutionResult:
        await asyncio.sleep(0.06)
        return CommandExecutionResult({"paused": True})

    async def exercise() -> None:
        with SQLiteCommandJournal(tmp_path / "runtime.sqlite3") as journal:
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                worker = ProtocolV2CommandWorker(
                    server="https://api.monofarm.app",
                    device_id=DEVICE_ID,
                    journal=journal,
                    token_provider=_TokenProvider(),
                    handler=handler,
                    client=client,
                    lease_heartbeat_interval=0.01,
                )
                await worker.run_once()

    asyncio.run(exercise())

    assert ack_states[:2] == ["accepted", "executing"]
    assert ack_states.count("executing") >= 2
    assert ack_states[-1] == "terminal"


def test_different_printers_execute_concurrently(tmp_path: Path) -> None:
    release = asyncio.Event()
    both_started = asyncio.Event()
    started: set[int] = set()

    async def transport(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/commands/pull"):
            return _json_response(
                request,
                _pull_response(
                    [
                        _wire_command(
                            command_id=COMMAND_ID,
                            printer_id=7,
                            command_type="printer.upload",
                        ),
                        _wire_command(
                            command_id="019f0000-0000-7000-8000-000000000011",
                            printer_id=8,
                            command_type="printer.upload",
                        ),
                    ]
                ),
            )
        if request.url.path.endswith("/events/batch"):
            events = json.loads(request.content)["events"]
            return _json_response(request, _event_response(events[-1]["sequence"]))
        return _json_response(request, {"ok": True})

    async def handler(command) -> CommandExecutionResult:
        started.add(command.printer_id)
        if started == {7, 8}:
            both_started.set()
        await release.wait()
        return CommandExecutionResult({"uploaded": True})

    async def exercise() -> None:
        with SQLiteCommandJournal(tmp_path / "runtime.sqlite3") as journal:
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                worker = ProtocolV2CommandWorker(
                    server="https://api.monofarm.app",
                    device_id=DEVICE_ID,
                    journal=journal,
                    token_provider=_TokenProvider(),
                    handler=handler,
                    client=client,
                    pull_batch_size=2,
                )
                cycle = asyncio.create_task(worker.run_once())
                try:
                    await asyncio.wait_for(both_started.wait(), timeout=0.2)
                finally:
                    release.set()
                await cycle

    asyncio.run(exercise())

    assert started == {7, 8}


def test_control_lane_bypasses_active_upload_for_same_printer(tmp_path: Path) -> None:
    upload_started = asyncio.Event()
    release_upload = asyncio.Event()
    pause_executed = asyncio.Event()
    pull_count = 0

    async def transport(request: httpx.Request) -> httpx.Response:
        nonlocal pull_count
        if request.url.path.endswith("/commands/pull"):
            pull_count += 1
            if pull_count == 1:
                commands = [
                    _wire_command(command_type="printer.upload", printer_id=7)
                ]
            elif pull_count == 2:
                commands = [
                    _wire_command(
                        command_id="019f0000-0000-7000-8000-000000000012",
                        command_type="printer.pause",
                        printer_id=7,
                    )
                ]
            else:
                commands = []
            return _json_response(request, _pull_response(commands))
        if request.url.path.endswith("/events/batch"):
            events = json.loads(request.content)["events"]
            return _json_response(request, _event_response(events[-1]["sequence"]))
        return _json_response(request, {"ok": True})

    async def handler(command) -> CommandExecutionResult:
        if command.command_type == "printer.upload":
            upload_started.set()
            await release_upload.wait()
            return CommandExecutionResult({"uploaded": True})
        if command.command_type == "printer.pause":
            pause_executed.set()
            return CommandExecutionResult({"paused": True})
        raise AssertionError(command.command_type)

    async def exercise() -> None:
        with SQLiteCommandJournal(tmp_path / "runtime.sqlite3") as journal:
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                worker = ProtocolV2CommandWorker(
                    server="https://api.monofarm.app",
                    device_id=DEVICE_ID,
                    journal=journal,
                    token_provider=_TokenProvider(),
                    handler=handler,
                    client=client,
                    pull_batch_size=1,
                    poll_interval=0.01,
                )
                worker_task = asyncio.create_task(worker.run())
                try:
                    await asyncio.wait_for(upload_started.wait(), timeout=0.2)
                    await asyncio.wait_for(pause_executed.wait(), timeout=0.2)
                finally:
                    release_upload.set()
                    worker_task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await worker_task

    asyncio.run(exercise())

    assert pull_count >= 2


def test_worker_closes_factory_owned_client_when_cancelled(tmp_path: Path) -> None:
    created: list[httpx.AsyncClient] = []

    def client_factory() -> httpx.AsyncClient:
        async def transport(request: httpx.Request) -> httpx.Response:
            return _json_response(request, _pull_response([]))

        client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        created.append(client)
        return client

    async def handler(_command) -> CommandExecutionResult:
        return CommandExecutionResult({})

    async def exercise() -> None:
        with SQLiteCommandJournal(tmp_path / "runtime.sqlite3") as journal:
            worker = ProtocolV2CommandWorker(
                server="https://api.monofarm.app",
                device_id=DEVICE_ID,
                journal=journal,
                token_provider=_TokenProvider(),
                handler=handler,
                client_factory=client_factory,
                poll_interval=0.01,
            )
            task = asyncio.create_task(worker.run())
            while not created:
                await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(exercise())

    assert len(created) == 1
    assert created[0].is_closed


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("pull_batch_size", 51),
        ("lease_seconds", 4),
        ("outbox_batch_size", 101),
        ("poll_interval", 0),
    ],
)
def test_worker_rejects_unbounded_protocol_settings(
    tmp_path: Path,
    field: str,
    value: int,
) -> None:
    kwargs = {
        "server": "https://api.monofarm.app",
        "device_id": DEVICE_ID,
        "journal": SQLiteCommandJournal(tmp_path / "runtime.sqlite3"),
        "token_provider": _TokenProvider(),
        "handler": lambda _command: None,
        field: value,
    }
    with pytest.raises(ValueError):
        ProtocolV2CommandWorker(**kwargs)  # type: ignore[arg-type]
    kwargs["journal"].close()
