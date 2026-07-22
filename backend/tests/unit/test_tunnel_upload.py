"""Tunnel MOONRAKER_UPLOAD reliability: progress-aware timeouts + org-scoped cleanup.

Regression for the production failure "Agent MOONRAKER_UPLOAD timed out (349.2s)":
a slow printer (U1 over WiFi at ~30 KB/s) kept reporting upload progress, but the
fixed size-based timeout killed the live upload anyway. The tunnel must only fail
an upload that has actually stalled (no progress messages), not a slow-but-alive one.
"""

import asyncio
import json
import logging

import pytest

from app.services import moonraker, tunnel


class FakeWS:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))


@pytest.fixture(autouse=True)
def clean_tunnel_state():
    tunnel._tunnels.clear()
    tunnel._agent_capabilities.clear()
    tunnel._pending.clear()
    tunnel._pending_org.clear()
    tunnel._pending_upload_progress.clear()
    tunnel._upload_progress_error_logged.clear()
    yield
    tunnel._tunnels.clear()
    tunnel._agent_capabilities.clear()
    tunnel._pending.clear()
    tunnel._pending_org.clear()
    tunnel._pending_upload_progress.clear()
    tunnel._upload_progress_error_logged.clear()


def _register(org_id: int = 1) -> FakeWS:
    ws = FakeWS()
    tunnel._tunnels[org_id] = ws
    tunnel._agent_capabilities[org_id] = set()
    return ws


def _req_id(ws: FakeWS) -> str:
    return ws.sent[0]["id"]


def test_slow_upload_survives_past_sized_timeout_while_progress_flows(monkeypatch):
    """Progress messages must keep the upload alive beyond the old fixed budget."""
    ws = _register()
    # Old behaviour: this sized value was the absolute deadline → upload died at 0.1s.
    monkeypatch.setattr(moonraker, "upload_timeout_for_size", lambda _size: 0.1)
    monkeypatch.setattr(tunnel, "UPLOAD_STALL_TIMEOUT", 0.4)
    seen: list[int] = []

    async def progress_cb(data):
        seen.append(int(data.get("sent") or 0))

    async def scenario():
        upload = asyncio.create_task(tunnel.send_moonraker_upload(
            1, "http://192.168.31.24/", "part.gcode", b"G28\n",
            progress_callback=progress_cb,
        ))
        await asyncio.sleep(0.05)
        req_id = _req_id(ws)
        # Progress every 0.1s for 0.5s total — five times the old 0.1s budget.
        for i in range(5):
            await tunnel.handle_agent_message(
                {"id": req_id, "type": "upload_progress", "sent": i + 1, "total": 5},
                org_id=1,
            )
            await asyncio.sleep(0.1)
        await tunnel.handle_agent_message(
            {"id": req_id, "status": 201, "body": {"result": {"print_started": False}}, "error": None},
            org_id=1,
        )
        return await upload

    result = asyncio.run(scenario())
    assert result == {"result": {"print_started": False}}
    assert seen == [1, 2, 3, 4, 5]


def test_upload_fails_when_no_progress_within_stall_window(monkeypatch):
    ws = _register()
    monkeypatch.setattr(tunnel, "UPLOAD_STALL_TIMEOUT", 0.2)

    async def scenario():
        await tunnel.send_moonraker_upload(1, "http://192.168.31.24/", "part.gcode", b"G28\n")

    with pytest.raises(RuntimeError, match="без прогресу"):
        asyncio.run(scenario())
    assert ws.sent  # request did go out before the stall was detected


def test_explicit_timeout_is_a_hard_cap_even_with_progress(monkeypatch):
    ws = _register()
    monkeypatch.setattr(tunnel, "UPLOAD_STALL_TIMEOUT", 10.0)

    async def scenario():
        upload = asyncio.create_task(tunnel.send_moonraker_upload(
            1, "http://192.168.31.24/", "part.gcode", b"G28\n", timeout=0.3))
        await asyncio.sleep(0.05)
        req_id = _req_id(ws)

        async def feeder():
            while True:
                await tunnel.handle_agent_message(
                    {"id": req_id, "type": "upload_progress", "sent": 1, "total": 5},
                    org_id=1,
                )
                await asyncio.sleep(0.05)

        feed = asyncio.create_task(feeder())
        try:
            return await upload
        finally:
            feed.cancel()

    with pytest.raises(RuntimeError, match="timed out"):
        asyncio.run(scenario())


def test_unregister_only_fails_requests_of_its_own_org(monkeypatch):
    ws1 = _register(1)
    _register(2)
    monkeypatch.setattr(tunnel, "UPLOAD_STALL_TIMEOUT", 5.0)

    async def scenario():
        upload = asyncio.create_task(tunnel.send_moonraker_upload(
            1, "http://192.168.31.24/", "part.gcode", b"G28\n"))
        await asyncio.sleep(0.05)
        # Another org's agent drops — must not kill org 1's in-flight upload.
        await tunnel.unregister(2, tunnel._tunnels[2])
        await asyncio.sleep(0.05)
        assert not upload.done()
        await tunnel.handle_agent_message(
            {"id": _req_id(ws1), "status": 201, "body": {"ok": True}, "error": None},
            org_id=1,
        )
        return await upload

    assert asyncio.run(scenario()) == {"ok": True}


def test_presigned_url_skips_chunk_transfer_when_agent_supports_it(monkeypatch):
    ws = _register()
    tunnel._agent_capabilities[1] = {"moonraker_upload_chunks", "moonraker_upload_url"}
    monkeypatch.setattr(tunnel, "UPLOAD_STALL_TIMEOUT", 5.0)

    async def scenario():
        upload = asyncio.create_task(tunnel.send_moonraker_upload(
            1, "http://192.168.31.24/", "part.gcode", b"G28\n" * 100,
            presigned_url="https://r2.example/part.gcode?sig=x",
            print_options={"timelapse": False},
        ))
        await asyncio.sleep(0.05)
        await tunnel.handle_agent_message(
            {"id": _req_id(ws), "status": 201, "body": {"ok": True}, "error": None},
            org_id=1,
        )
        return await upload

    assert asyncio.run(scenario()) == {"ok": True}
    assert len(ws.sent) == 1  # single request message — no chunk messages
    assert ws.sent[0]["download_url"] == "https://r2.example/part.gcode?sig=x"
    assert ws.sent[0]["print_options"] == {"timelapse": False}
    assert "data_b64" not in ws.sent[0]


def test_presigned_url_falls_back_to_chunks_for_old_agents(monkeypatch):
    ws = _register()
    tunnel._agent_capabilities[1] = {"moonraker_upload_chunks"}  # no url capability
    monkeypatch.setattr(tunnel, "UPLOAD_STALL_TIMEOUT", 5.0)

    async def scenario():
        upload = asyncio.create_task(tunnel.send_moonraker_upload(
            1, "http://192.168.31.24/", "part.gcode", b"G28\n",
            presigned_url="https://r2.example/part.gcode?sig=x",
        ))
        await asyncio.sleep(0.05)
        await tunnel.handle_agent_message(
            {"id": _req_id(ws), "status": 201, "body": {"ok": True}, "error": None},
            org_id=1,
        )
        return await upload

    assert asyncio.run(scenario()) == {"ok": True}
    assert ws.sent[0].get("chunked") is True
    assert "download_url" not in ws.sent[0]
    assert any(m.get("method") == "MOONRAKER_UPLOAD_CHUNK" for m in ws.sent[1:])


def test_bambu_upload_forwards_agent_progress(monkeypatch):
    ws = _register()
    seen: list[dict] = []

    async def scenario():
        upload = asyncio.create_task(tunnel.send_bambu_upload(
            1,
            "192.168.31.24",
            "access",
            "model.3mf",
            presigned_url="https://r2.example/model.3mf?sig=x",
            progress_callback=seen.append,
        ))
        await asyncio.sleep(0.05)
        req_id = _req_id(ws)
        await tunnel.handle_agent_message({
            "id": req_id,
            "type": "upload_progress",
            "phase": "uploading",
            "sent": 50,
            "total": 100,
        }, org_id=1)
        await tunnel.handle_agent_message(
            {"id": req_id, "status": 200, "body": {"path": "model.3mf"}},
            org_id=1,
        )
        return await upload

    assert asyncio.run(scenario()) == "model.3mf"
    assert seen == [{"id": _req_id(ws), "type": "upload_progress", "phase": "uploading", "sent": 50, "total": 100}]


def test_bambu_upload_fails_when_agent_stalls(monkeypatch):
    ws = _register()
    monkeypatch.setattr(tunnel, "UPLOAD_STALL_TIMEOUT", 0.2)

    async def scenario():
        await tunnel.send_bambu_upload(
            1,
            "192.168.31.24",
            "access",
            "model.3mf",
            presigned_url="https://r2.example/model.3mf?sig=x",
            timeout=1.0,
        )

    with pytest.raises(RuntimeError, match="без прогресу"):
        asyncio.run(scenario())
    assert ws.sent


def test_upload_progress_callback_error_does_not_escape_agent_message_loop():
    async def broken_callback(_data):
        raise RuntimeError("job was cancelled while upload was still running")

    tunnel._pending_upload_progress["upload-1"] = broken_callback

    asyncio.run(tunnel.handle_agent_message({
        "id": "upload-1",
        "type": "upload_progress",
        "phase": "uploading",
        "sent": 1,
        "total": 100,
    }))


def test_upload_progress_callback_error_is_logged_once(caplog):
    async def broken_callback(_data):
        raise RuntimeError("job was cancelled while upload was still running")

    tunnel._pending_org["upload-1"] = 1
    tunnel._pending_upload_progress["upload-1"] = broken_callback

    with caplog.at_level(logging.WARNING):
        for _ in range(2):
            asyncio.run(tunnel.handle_agent_message({
                "id": "upload-1",
                "type": "upload_progress",
                "phase": "uploading",
                "sent": 1,
                "total": 100,
            }, org_id=1))

    messages = [record.message for record in caplog.records if "upload_progress callback failed" in record.message]
    assert len(messages) == 1


def test_upload_progress_from_another_org_is_ignored():
    seen: list[dict] = []
    tunnel._pending_org["upload-1"] = 1
    tunnel._pending_upload_progress["upload-1"] = seen.append

    asyncio.run(tunnel.handle_agent_message({
        "id": "upload-1",
        "type": "upload_progress",
        "phase": "uploading",
        "sent": 1,
        "total": 100,
    }, org_id=2))

    assert seen == []


@pytest.mark.parametrize(
    ("sent", "total"),
    [
        (-1, 100),
        (1, -1),
        (True, 100),
        (1, "100"),
        (101, 100),
    ],
)
def test_invalid_upload_progress_envelope_is_ignored(sent, total):
    seen: list[dict] = []
    tunnel._pending_org["upload-1"] = 1
    tunnel._pending_upload_progress["upload-1"] = seen.append

    asyncio.run(tunnel.handle_agent_message({
        "id": "upload-1",
        "type": "upload_progress",
        "phase": "uploading",
        "sent": sent,
        "total": total,
    }, org_id=1))

    assert seen == []


def test_proxy_stream_binds_chunks_to_the_requesting_org():
    ws = _register(1)

    async def scenario():
        stream = tunnel.proxy_stream(1, "http://camera/stream", chunk_timeout=1)
        next_chunk = asyncio.create_task(anext(stream))
        await asyncio.sleep(0.01)
        req_id = _req_id(ws)
        assert tunnel._pending_org.get(req_id) == 1

        await tunnel.handle_agent_message({
            "id": req_id,
            "type": "chunk",
            "data": "aW50cnVkZXI=",
        }, org_id=2)
        await asyncio.sleep(0)
        assert not next_chunk.done()

        await tunnel.handle_agent_message({
            "id": req_id,
            "type": "stream_end",
        }, org_id=1)
        with pytest.raises(StopAsyncIteration):
            await next_chunk
        await stream.aclose()
        assert req_id not in tunnel._pending_org

    asyncio.run(scenario())


def test_unregister_of_stale_socket_keeps_replacement_tunnel():
    old_ws = _register(1)
    new_ws = FakeWS()
    tunnel._tunnels[1] = new_ws  # agent reconnected — entry replaced

    asyncio.run(tunnel.unregister(1, old_ws))

    assert tunnel._tunnels.get(1) is new_ws
    assert old_ws is not new_ws
