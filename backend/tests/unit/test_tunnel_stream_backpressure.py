import asyncio
import base64
import json

import pytest

from app.services import tunnel


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_text(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


@pytest.fixture(autouse=True)
def _clear_tunnel_state():
    tunnel._tunnels.clear()
    tunnel._pending_streams.clear()
    tunnel._pending_stream_org.clear()
    yield
    tunnel._tunnels.clear()
    tunnel._pending_streams.clear()
    tunnel._pending_stream_org.clear()


def test_stream_queue_drops_oldest_frame_when_consumer_is_slow() -> None:
    async def exercise() -> None:
        queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=2)
        queue.put_nowait(b"old-1")
        queue.put_nowait(b"old-2")
        tunnel._pending_streams["stream-1"] = queue

        await tunnel.handle_agent_message(
            {
                "id": "stream-1",
                "type": "chunk",
                "data": base64.b64encode(b"new").decode("ascii"),
            },
            org_id=1,
        )

        assert queue.qsize() == 2
        assert queue.get_nowait() == b"old-2"
        assert queue.get_nowait() == b"new"

    asyncio.run(exercise())


def test_closing_proxy_stream_sends_cancel_and_releases_queue() -> None:
    async def exercise() -> None:
        ws = _FakeWebSocket()
        tunnel._tunnels[7] = ws
        stream = tunnel.proxy_stream(7, "http://printer.local/webcam")
        next_chunk = asyncio.create_task(anext(stream))

        for _ in range(20):
            if ws.sent:
                break
            await asyncio.sleep(0)
        request = ws.sent[0]
        assert request["method"] == "STREAM"
        req_id = request["id"]
        await tunnel.handle_agent_message(
            {
                "id": req_id,
                "type": "chunk",
                "data": base64.b64encode(b"frame").decode("ascii"),
            },
            org_id=7,
        )

        assert await next_chunk == b"frame"
        await stream.aclose()

        assert ws.sent[-1] == {"id": req_id, "method": "STREAM_CANCEL"}
        assert req_id not in tunnel._pending_streams

    asyncio.run(exercise())


def test_stream_end_is_delivered_even_when_queue_is_full() -> None:
    async def exercise() -> None:
        queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=1)
        queue.put_nowait(b"stale")
        tunnel._pending_streams["stream-1"] = queue

        await tunnel.handle_agent_message(
            {"id": "stream-1", "type": "stream_end"},
            org_id=1,
        )

        assert queue.get_nowait() is None

    asyncio.run(exercise())


def test_agent_disconnect_ends_only_its_organization_streams() -> None:
    async def exercise() -> None:
        org_one_ws = _FakeWebSocket()
        org_two_ws = _FakeWebSocket()
        tunnel._tunnels.update({1: org_one_ws, 2: org_two_ws})
        org_one_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=1)
        org_two_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=1)
        tunnel._pending_streams.update({"one": org_one_queue, "two": org_two_queue})
        tunnel._pending_stream_org.update({"one": 1, "two": 2})

        await tunnel.unregister(1, org_one_ws)

        assert org_one_queue.get_nowait() is None
        assert org_two_queue.empty()
        assert "one" not in tunnel._pending_stream_org
        assert tunnel._pending_stream_org["two"] == 2

    asyncio.run(exercise())
