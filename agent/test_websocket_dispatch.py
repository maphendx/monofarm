import asyncio
import io
import json
import zipfile

from core.state import runtime_state
from core.updates import _validated_archive_files
from transports import websocket


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send(self, payload):
        self.messages.append(json.loads(payload))


def test_agent_hello_preserves_wire_contract():
    socket = FakeWebSocket()

    asyncio.run(websocket.send_hello(socket, "9.8.7"))

    assert socket.messages == [
        {
            "type": "AGENT_HELLO",
            "version": "9.8.7",
            "capabilities": [
                "moonraker_upload_chunks",
                "moonraker_upload_url",
                "moonraker_upload_local_transform",
            ],
        }
    ]


def test_regular_request_falls_through_without_mutating_envelope(monkeypatch):
    received = []

    async def handler(socket, request):
        received.append((socket, request))

    monkeypatch.setattr(websocket, "handle_request", handler)
    socket = FakeWebSocket()
    request = {"id": "req-1", "method": "POST", "url": "http://printer/api", "body": {"x": 1}}

    async def exercise():
        await websocket.dispatch_message(socket, request, "0.8.16")
        await asyncio.sleep(0)

    asyncio.run(exercise())

    assert received == [(socket, request)]


def test_named_methods_keep_their_handler_routes(monkeypatch):
    calls = []
    routes = [
        ("MOONRAKER_SUBSCRIBE", websocket.moonraker, "handle_moonraker_subscribe"),
        ("BAMBU_CAMERA", websocket.bambu, "handle_bambu_camera"),
        ("FFMPEG_STREAM", websocket, "handle_ffmpeg_stream"),
        ("DISCOVER_BAMBU", websocket.bambu, "handle_discover_bambu"),
        ("DISCOVER_MOONRAKER", websocket, "handle_discover_moonraker"),
        ("BAMBU_UPLOAD", websocket.bambu, "handle_bambu_upload"),
        ("BAMBU_MQTT", websocket.bambu, "handle_bambu_mqtt"),
        ("ANYCUBIC_MQTT", websocket.anycubic, "handle_anycubic_command"),
        ("MOONRAKER_UPLOAD", websocket.moonraker, "handle_moonraker_upload"),
        ("PRINT_ZPL", websocket, "handle_print_zpl"),
        ("STREAM", websocket, "handle_stream"),
    ]

    for method, owner, attribute in routes:
        async def handler(socket, request, route=method):
            calls.append((route, socket, request))

        monkeypatch.setattr(owner, attribute, handler)

    socket = FakeWebSocket()

    async def exercise():
        for method, *_ in routes:
            request = {"id": method.lower(), "method": method}
            await websocket.dispatch_message(socket, request, "0.8.16")
            await asyncio.sleep(0)

    asyncio.run(exercise())

    assert [method for method, *_ in calls] == [method for method, *_ in routes]
    assert all(call_socket is socket for _, call_socket, _ in calls)


def test_chunked_upload_metadata_uses_shared_runtime_buffer():
    runtime_state.upload_buffers.clear()
    request = {
        "id": "upload-1",
        "method": "MOONRAKER_UPLOAD",
        "chunked": True,
        "total_bytes": 123,
    }

    asyncio.run(websocket.dispatch_message(FakeWebSocket(), request, "0.8.16"))

    state = runtime_state.upload_buffers.pop("upload-1")
    assert state["meta"] is request
    assert state["data"] == bytearray()
    assert state["next_offset"] == 0
    assert state["total_bytes"] == 123


def test_source_archive_rejects_path_traversal():
    output = io.BytesIO()
    manifest = ["monofarm_agent.py", "source_manifest.json", "../escape.py"]
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("source_manifest.json", json.dumps(manifest))
        archive.writestr("monofarm_agent.py", b"")
        archive.writestr("../escape.py", b"")

    try:
        _validated_archive_files(output.getvalue())
    except ValueError as exc:
        assert "unsafe archive path" in str(exc)
    else:
        raise AssertionError("path traversal archive should be rejected")
