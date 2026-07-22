import asyncio
import json

import monofarm_agent
from anycubic_local import commands
from monofarm_agent import (
    _ANYCUBIC_STATUS_POLL_INTERVAL,
    _anycubic_poll_requests,
    handle_anycubic_command,
)


def test_anycubic_poll_refreshes_status_before_backend_cache_expires():
    requests = _anycubic_poll_requests("20026", "DEV-1", timestamp_ms=1234)
    payloads = {json.loads(body)["type"]: (topic, json.loads(body)) for topic, body in requests}
    next_requests = _anycubic_poll_requests("20026", "DEV-1", timestamp_ms=1234)
    message_ids = {payload[1]["msgid"] for payload in payloads.values()}
    next_message_ids = {json.loads(body)["msgid"] for _, body in next_requests}

    assert _ANYCUBIC_STATUS_POLL_INTERVAL < 30
    assert set(payloads) == {"info", "multiColorBox"}
    assert len(message_ids) == 2
    assert message_ids.isdisjoint(next_message_ids)
    assert payloads["info"][0].endswith("/DEV-1/info")
    assert payloads["info"][1]["action"] == "query"
    assert payloads["info"][1]["timestamp"] == 1234
    assert payloads["info"][1]["data"] is None
    assert payloads["multiColorBox"][1]["action"] == "getInfo"


def test_anycubic_command_supplies_live_timestamp_for_source_updates(monkeypatch):
    captured = {}

    class Client:
        def is_connected(self):
            return True

        def publish(self, _topic, _payload):
            return None

    class WebSocket:
        async def send(self, _payload):
            return None

    def fake_build(_model_id, _dev_id, _command, **kwargs):
        captured.update(kwargs)
        return "topic", {"ok": True}

    monkeypatch.setattr(commands, "build", fake_build)
    monkeypatch.setattr(monofarm_agent.time, "time", lambda: 1.234)
    monofarm_agent._anycubic_live_clients["DEV-1"] = Client()

    asyncio.run(handle_anycubic_command(WebSocket(), {
        "id": "request-1",
        "dev_id": "DEV-1",
        "model_id": "20026",
        "command": "light",
        "on": True,
    }))

    assert captured["ts"] == 1234
