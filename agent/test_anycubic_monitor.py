import json

from monofarm_agent import (
    _ANYCUBIC_STATUS_POLL_INTERVAL,
    _anycubic_poll_requests,
)


def test_anycubic_poll_refreshes_status_before_backend_cache_expires():
    requests = _anycubic_poll_requests("20026", "DEV-1", timestamp_ms=1234)
    payloads = {json.loads(body)["type"]: (topic, json.loads(body)) for topic, body in requests}

    assert _ANYCUBIC_STATUS_POLL_INTERVAL < 30
    assert set(payloads) == {"info", "multiColorBox"}
    assert payloads["info"][0].endswith("/DEV-1/info")
    assert payloads["info"][1] == {
        "type": "info",
        "action": "query",
        "timestamp": 1234,
        "msgid": "poll",
        "data": None,
    }
    assert payloads["multiColorBox"][1]["action"] == "getInfo"
