from __future__ import annotations

import asyncio
import time
from uuid import uuid4

from app.api import agent as agent_api
from app.services import tunnel


class _FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.closed: tuple[int, str] | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, *, code: int, reason: str) -> None:
        self.closed = (code, reason)

    async def send_text(self, _value: str) -> None:
        return None


def test_v2_device_connectivity_replaces_only_the_same_device_and_fences_old_socket() -> None:
    async def scenario() -> None:
        org_id = 91_001
        first_device = uuid4()
        second_device = uuid4()
        first_socket = _FakeWebSocket()
        replacement_socket = _FakeWebSocket()
        other_device_socket = _FakeWebSocket()
        try:
            assert await tunnel.register(org_id, first_socket, device_id=first_device)
            assert tunnel.connected_device_id(org_id) == first_device
            assert tunnel.is_device_connected(org_id, first_device) is True

            assert not await tunnel.register(
                org_id,
                other_device_socket,
                device_id=second_device,
            )
            assert tunnel.connected_device_id(org_id) == first_device
            assert tunnel.is_device_connected(org_id, first_device) is True

            # Closing the rejected socket must not remove the live one.
            await tunnel.unregister(org_id, other_device_socket)
            assert tunnel.connected_device_id(org_id) == first_device

            assert await tunnel.register(
                org_id,
                replacement_socket,
                device_id=first_device,
            )
            assert first_socket.closed == (
                4008,
                "Superseded by a newer connection for this device",
            )
            assert tunnel.connected_device_id(org_id) == first_device

            # The fenced handler may finish after the replacement registered.
            # Its stale cleanup must not unregister the new socket.
            await tunnel.unregister(org_id, first_socket)
            assert tunnel.connected_device_id(org_id) == first_device

            await tunnel.unregister(org_id, replacement_socket)
            assert tunnel.connected_device_id(org_id) is None
        finally:
            await tunnel.unregister(org_id)

    asyncio.run(scenario())


def test_websocket_entrypoint_closes_a_concurrent_v2_socket_with_4009() -> None:
    async def scenario() -> None:
        org_id = 91_003
        first_socket = _FakeWebSocket()
        rejected_socket = _FakeWebSocket()
        try:
            assert await tunnel.register(org_id, first_socket, device_id=uuid4())

            await agent_api._serve_agent_socket(
                rejected_socket,
                org_id,
                device_id=uuid4(),
            )

            assert rejected_socket.accepted is True
            assert rejected_socket.closed == (
                4009,
                "Another farm agent is already connected",
            )
        finally:
            await tunnel.unregister(org_id, first_socket)

    asyncio.run(scenario())


def test_legacy_socket_cannot_replace_a_live_v2_device() -> None:
    async def scenario() -> None:
        org_id = 91_002
        device_id = uuid4()
        v2_socket = _FakeWebSocket()
        legacy_socket = _FakeWebSocket()
        try:
            assert await tunnel.register(org_id, v2_socket, device_id=device_id)
            assert not await tunnel.register(org_id, legacy_socket)

            assert tunnel.has_tunnel(org_id) is True
            assert tunnel.connected_device_id(org_id) == device_id
            assert tunnel.is_device_connected(org_id, device_id) is True
        finally:
            await tunnel.unregister(org_id)

    asyncio.run(scenario())


def test_same_device_reconnect_keeps_only_one_history_backfill(monkeypatch) -> None:
    async def scenario() -> None:
        org_id = 91_004
        device_id = uuid4()
        first_socket = _FakeWebSocket()
        replacement_socket = _FakeWebSocket()
        release = asyncio.Event()
        started: list[tuple[int, object]] = []

        async def fake_subscribe(*_args, **_kwargs) -> None:
            return None

        async def fake_backfill(backfill_org_id: int, *, device_id=None) -> None:
            started.append((backfill_org_id, device_id))
            await release.wait()

        monkeypatch.setattr(tunnel, "_subscribe_org_printers", fake_subscribe)
        monkeypatch.setattr(tunnel, "_backfill_org_history", fake_backfill)

        try:
            assert await tunnel.register(org_id, first_socket, device_id=device_id)
            assert await tunnel.register(org_id, replacement_socket, device_id=device_id)
            await asyncio.sleep(0)

            assert started == [(org_id, device_id)]
        finally:
            release.set()
            await asyncio.sleep(0)
            await tunnel.unregister(org_id)

    asyncio.run(scenario())


def test_v2_target_authorization_does_not_block_the_event_loop(monkeypatch) -> None:
    async def scenario() -> None:
        def slow_authorization(*_args, **_kwargs) -> None:
            time.sleep(0.1)

        monkeypatch.setattr(tunnel, "_authorize_v2_message_target", slow_authorization)
        monkeypatch.setattr(tunnel, "_handle_status_push", lambda *_args: None)

        message_task = asyncio.create_task(
            tunnel.handle_agent_message(
                {
                    "type": "STATUS_PUSH",
                    "url": "http://192.168.1.20:7125",
                    "status": {"print_stats": {"state": "standby"}},
                },
                org_id=91_005,
                device_id=uuid4(),
                scopes=frozenset({"status:write"}),
            )
        )
        event_loop_tick = asyncio.create_task(asyncio.sleep(0))

        await event_loop_tick
        assert message_task.done() is False
        await message_task

    asyncio.run(scenario())
