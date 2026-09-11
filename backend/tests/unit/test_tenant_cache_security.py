"""Two farms using the same LAN address must never share printer state."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from app.services import moonraker, tunnel

URL = "http://192.168.1.100"


@pytest.fixture
def cache(monkeypatch):
    values = {}
    monkeypatch.setattr("app.services.cache.cache_get", values.get)
    monkeypatch.setattr("app.services.cache.cache_set", lambda key, value, ttl: values.__setitem__(key, value))
    monkeypatch.setattr("app.services.cache.cache_delete", lambda key: values.pop(key, None))
    monkeypatch.setattr(moonraker, "_status_cache", {})
    return values


def push(org_id, filename):
    tunnel._handle_status_push({"url": URL, "status": {"print_stats": {"state": "printing", "filename": filename}}}, org_id)


def test_same_lan_ip_has_separate_status_for_each_org(cache):
    push(1, "private-A.gcode")
    assert moonraker.get_cached_live_status(URL, org_id=2) is None
    push(2, "private-B.gcode")
    assert moonraker.get_cached_live_status(URL, org_id=1)["filename"] == "private-A.gcode"
    assert moonraker.get_cached_live_status(URL + "/", org_id=2)["filename"] == "private-B.gcode"


def test_old_unscoped_cache_is_never_used(cache):
    cache[f"mr:status:{URL}"] = {"filename": "legacy-private.gcode"}
    moonraker._status_cache[URL] = {"filename": "legacy-private.gcode"}
    assert moonraker.get_cached_live_status(URL, org_id=1) is None


def test_bed_clear_and_invalidation_are_scoped(cache):
    for org_id in (1, 2):
        cache[moonraker._status_cache_key("status", URL, org_id)] = {"state": "operational", "filename": "part.gcode"}
    moonraker.mark_bed_cleared(URL, "part.gcode", org_id=1)
    assert moonraker.get_cached_live_status(URL, org_id=1)["state"] == "idle"
    assert moonraker.get_cached_live_status(URL, org_id=2)["state"] == "operational"
    moonraker.invalidate_status(URL, org_id=1)
    assert moonraker.get_cached_live_status(URL, org_id=2)["filename"] == "part.gcode"


@pytest.mark.asyncio
async def test_tunnel_does_not_reuse_another_org_cached_status(cache, monkeypatch):
    push(1, "private-A.gcode")
    proxy = AsyncMock(return_value={"status": 200, "body": {"result": {"status": {"print_stats": {"state": "standby"}}}}})
    monkeypatch.setattr(tunnel, "proxy_request", proxy)
    result = await tunnel.get_moonraker_status(2, URL)
    assert result.get("filename") != "private-A.gcode"
    assert proxy.call_args.args[0] == 2


def test_remote_file_metadata_is_scoped(cache, monkeypatch):
    fetch = iter([{"colors": ["#111111"]}, {"colors": ["#222222"]}])
    monkeypatch.setattr(moonraker, "_fetch_moonraker_metadata", lambda *a: next(fetch))
    assert moonraker.get_remote_file_meta(URL, "part.gcode", org_id=1)["colors"] == ["#111111"]
    assert moonraker.get_remote_file_meta(URL, "part.gcode", org_id=2)["colors"] == ["#222222"]


@pytest.mark.asyncio
async def test_foreign_agent_response_cannot_resolve_another_org_request(monkeypatch):
    future = asyncio.get_running_loop().create_future()
    monkeypatch.setattr(tunnel, "_pending", {"request": future})
    monkeypatch.setattr(tunnel, "_pending_org", {"request": 1})
    await tunnel.handle_agent_message({"id": "request", "status": 200, "body": "foreign"}, org_id=2)
    assert not future.done()
    await tunnel.handle_agent_message({"id": "request", "status": 200, "body": "own"}, org_id=1)
    assert future.result()["body"] == "own"


@pytest.fixture
def bambu_cache(cache, monkeypatch):
    from app.services import bambu
    for name in ("_state_cache", "_ams_cache", "_last_state_redis_write", "_last_ams_redis_write", "_confirmed_filament_slots"):
        monkeypatch.setattr(bambu, name, {})
    monkeypatch.setattr(bambu, "_subscriptions", set())
    monkeypatch.setattr(bambu, "_sync_cloud_job_from_report", lambda *a, **kw: None)
    monkeypatch.setattr(bambu, "_publish_printer_refresh", lambda *a, **kw: None)
    return cache


def test_bambu_same_serial_has_separate_state_and_ams(bambu_cache):
    from app.services import bambu
    for org_id, filename, color in [(1, "private-A.3mf", "FF0000FF"), (2, "private-B.3mf", "00FF00FF")]:
        bambu.handle_agent_report(org_id, "SAME-SERIAL", {"print": {
            "gcode_state": "RUNNING", "subtask_name": filename,
            "vt_tray": {"tray_type": "PLA", "tray_color": color},
        }})
    assert bambu.get_cached_state("SAME-SERIAL", org_id=1)["filename"] == "private-A.3mf"
    assert bambu.get_cached_state("SAME-SERIAL", org_id=2)["filename"] == "private-B.3mf"
    assert bambu.get_ams_filaments("SAME-SERIAL", org_id=1)[0]["color"] == "#FF0000"
    assert bambu.get_ams_filaments("SAME-SERIAL", org_id=2)[0]["color"] == "#00FF00"
    assert bambu.get_cached_state("SAME-SERIAL", org_id=3) == {"state": "offline"}
    assert bambu.get_ams_filaments("SAME-SERIAL", org_id=3) == []


def test_bambu_old_global_keys_are_not_read(bambu_cache):
    from app.services import bambu
    bambu_cache["bambu:state:SAME-SERIAL"] = {"filename": "legacy-private.3mf"}
    bambu_cache["bambu:ams:SAME-SERIAL"] = [{"type": "PRIVATE"}]
    bambu._state_cache["SAME-SERIAL"] = {"filename": "legacy-private.3mf"}
    bambu._ams_cache["SAME-SERIAL"] = [{"type": "PRIVATE"}]
    assert bambu.get_cached_state("SAME-SERIAL", org_id=1) == {"state": "offline"}
    assert bambu.get_ams_filaments("SAME-SERIAL", org_id=1) == []


def test_bambu_command_uses_only_its_org_lan_client(monkeypatch):
    from unittest.mock import Mock
    from app.services import bambu
    first, second = Mock(), Mock()
    monkeypatch.setattr(bambu, "_lan_mqtt_clients", {(1, "SAME-SERIAL"): first, (2, "SAME-SERIAL"): second})
    bambu.pause_print("SAME-SERIAL", org_id=2)
    first.publish.assert_not_called()
    second.publish.assert_called_once()


def test_bambu_redis_command_includes_authenticated_org(monkeypatch):
    import json
    from unittest.mock import Mock
    from app.services import bambu
    redis = Mock()
    monkeypatch.setattr(bambu, "_lan_mqtt_clients", {})
    monkeypatch.setattr(bambu, "_mqtt_clients", {})
    monkeypatch.setattr("app.services.cache._r", lambda: redis)
    bambu.stop_print("SAME-SERIAL", org_id=2)
    channel, payload = redis.publish.call_args.args
    assert channel == "bambu:cmd"
    assert json.loads(payload)["org_id"] == 2


def test_mqtt_callback_requires_org_subscription(bambu_cache, monkeypatch):
    import json
    from types import SimpleNamespace
    from unittest.mock import Mock
    from app.services import bambu
    report = Mock()
    monkeypatch.setattr(bambu, "_handle_report_payload", report)
    monkeypatch.setattr(bambu, "_kick_autoprint_from_report", Mock())
    bambu._subscriptions.add((1, "KNOWN"))
    message = SimpleNamespace(topic="device/KNOWN/report", payload=json.dumps({"print": {"gcode_state": "IDLE"}}).encode())
    bambu._on_message(None, None, message)
    bambu._on_message(None, 2, message)
    report.assert_not_called()
    bambu._on_message(None, 1, message)
    assert report.call_args.kwargs == {"org_id": 1}


def test_camera_names_and_urls_are_separate_for_same_serial():
    from app.services import go2rtc

    assert go2rtc.stream_name("SAME-SERIAL", org_id=1) != go2rtc.stream_name("SAME-SERIAL", org_id=2)
    assert go2rtc.mjpeg_url("SAME-SERIAL", org_id=1) != go2rtc.mjpeg_url("SAME-SERIAL", org_id=2)
