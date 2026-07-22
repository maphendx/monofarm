from app.services import anycubic, anycubic_protocol


def _info_data(**overrides) -> dict:
    base = {
        "model": "Kobra 3 Max", "state": "busy",
        "temp": {"curr_nozzle_temp": 210.0, "target_nozzle_temp": 215.0,
                  "curr_hotbed_temp": 60.0, "target_hotbed_temp": 60.0},
        "project": {"state": "printing", "pause": 0, "progress": 42,
                     "curr_layer": 10, "total_layers": 100,
                     "remain_time": 30, "filename": "part.gcode"},
    }
    base.update(overrides)
    return base


def test_parse_info_idle_and_printing():
    idle = anycubic_protocol.parse_info({"state": "free", "temp": {}})
    assert idle["status"] == "idle"
    assert idle["paused"] is False

    printing = anycubic_protocol.parse_info(_info_data())
    assert printing["status"] == "printing"
    assert printing["progress"] == 42
    assert printing["nozzle_temp"] == 210.0
    assert printing["filename"] == "part.gcode"


def test_handle_agent_report_caches_unified_state(monkeypatch):
    store: dict[str, object] = {}
    monkeypatch.setattr("app.services.anycubic.cache_set", lambda k, v, ttl: store.__setitem__(k, v))
    monkeypatch.setattr("app.services.anycubic.cache_get", lambda k: store.get(k))

    anycubic.handle_agent_report("DEV-1", _info_data())
    live = anycubic.get_cached_state("DEV-1")
    assert live["state"] == "printing"
    assert live["progress_pct"] == 42
    assert live["nozzle_temp"] == 210.0
    assert live["state_stale"] is False


def test_get_cached_state_offline_when_nothing_cached(monkeypatch):
    monkeypatch.setattr("app.services.anycubic.cache_get", lambda k: None)
    assert anycubic.get_cached_state("UNKNOWN-DEV") == {"state": "offline"}


def test_handle_agent_report_paused_state(monkeypatch):
    store: dict[str, object] = {}
    monkeypatch.setattr("app.services.anycubic.cache_set", lambda k, v, ttl: store.__setitem__(k, v))
    monkeypatch.setattr("app.services.anycubic.cache_get", lambda k: store.get(k))

    anycubic.handle_agent_report("DEV-2", _info_data(project={
        "state": "paused", "pause": 1, "progress": 10, "filename": "x.gcode",
    }))
    assert anycubic.get_cached_state("DEV-2")["state"] == "paused"


def test_handle_agent_ace_report_merges_and_preserves_known_values(monkeypatch):
    store: dict[str, object] = {}
    monkeypatch.setattr("app.services.anycubic.cache_set", lambda k, v, ttl: store.__setitem__(k, v))
    monkeypatch.setattr("app.services.anycubic.cache_get", lambda k: store.get(k))

    anycubic.handle_agent_ace_report("DEV-3", {"multi_color_box": [
        {"id": 0, "temp": 35, "humidity": 24,
         "slots": [{"index": 1, "type": "PETG", "color": [255, 0, 0], "status": 5}]},
    ]})
    # Second report omits temp/humidity (activity-gated) — must not clobber known values.
    anycubic.handle_agent_ace_report("DEV-3", {"multi_color_box": [
        {"id": 0, "slots": [{"index": 2, "type": "PLA", "color": [0, 255, 0], "status": 4}]},
    ]})
    boxes = anycubic.get_ace_filaments("DEV-3")
    assert len(boxes) == 1
    box = boxes[0]
    assert box["temp"] == 35 and box["humidity"] == 24
    assert box["slots"][1]["material"] == "PETG"
    assert box["slots"][1]["color_hex"] == "#FF0000"
    assert box["slots"][2]["material"] == "PLA"
