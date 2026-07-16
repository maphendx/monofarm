import asyncio
import base64
import json

import monofarm_agent


class _FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


class _SlowResponse:
    status_code = 201
    content = b"{}"
    text = ""

    def json(self) -> dict:
        return {"result": {"print_started": False}}


class _SlowMoonrakerClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args) -> None:
        return None

    async def post(self, *_args, **_kwargs):
        # Simulate Moonraker waiting before it consumes the multipart body or
        # returns a response. The independent heartbeat must keep cloud alive.
        await asyncio.sleep(0.06)
        return _SlowResponse()


def test_moonraker_upload_heartbeats_while_waiting_for_printer(monkeypatch) -> None:
    monkeypatch.setattr(monofarm_agent, "MOONRAKER_UPLOAD_HEARTBEAT_INTERVAL", 0.01)
    monkeypatch.setattr(
        monofarm_agent.httpx,
        "AsyncClient",
        lambda **_kwargs: _SlowMoonrakerClient(),
    )
    ws = _FakeWebSocket()
    payload = base64.b64encode(b"G28\n" * 1024).decode()

    asyncio.run(monofarm_agent.handle_moonraker_upload(ws, {
        "id": "upload-1",
        "url": "http://192.168.31.210",
        "filename": "part.gcode",
        "data_b64": payload,
        "upload_timeout": 300,
    }))

    progress = [m for m in ws.messages if m.get("type") == "upload_progress"]
    assert len(progress) >= 2
    assert all(m.get("heartbeat") is True for m in progress)
    assert ws.messages[-1]["status"] == 201
