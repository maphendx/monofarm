import asyncio

from app.services import moonraker, tunnel


U1_URL = "http://192.168.31.210"
U1_SLOTS = [
    {
        "slot": 0,
        "color": "#8BD5EE",
        "color_name": None,
        "type": "PLA",
        "brand": None,
        "filament_id": None,
        "empty": False,
        "unit_id": None,
    },
]


def test_cached_status_matches_agent_url_without_trailing_slash(monkeypatch):
    requested: list[str] = []

    def fake_cache_get(key: str):
        requested.append(key)
        if key == f"mr:org:5:status:{U1_URL}":
            return {"state": "idle", "u1_filaments": U1_SLOTS}
        return None

    monkeypatch.setattr("app.services.cache.cache_get", fake_cache_get)
    moonraker._status_cache.clear()

    status = moonraker.get_cached_live_status(f"{U1_URL}/", org_id=5)

    assert status is not None
    assert status["u1_filaments"] == U1_SLOTS
    assert requested[0] == f"mr:org:5:status:{U1_URL}"


def test_u1_task_config_slots_are_verified_by_the_printer():
    slots = moonraker.u1_slots_from_task_config({
        "filament_exist": [True, False, False, False],
        "filament_color_rgba": ["#8BD5EEFF"],
        "filament_type": ["PLA"],
    })

    assert slots is not None
    assert slots[0]["verified"] is True


def test_status_push_keeps_last_u1_colors_when_packet_is_incomplete(monkeypatch):
    stored: dict[str, dict] = {
        f"mr:org:5:stale:{U1_URL}": {"state": "idle", "u1_filaments": U1_SLOTS},
    }

    monkeypatch.setattr("app.services.cache.cache_get", lambda key: stored.get(key))
    monkeypatch.setattr(
        "app.services.cache.cache_set",
        lambda key, value, _ttl: stored.__setitem__(key, value),
    )
    moonraker._status_cache.clear()

    changed = tunnel._handle_status_push({
        "url": f"{U1_URL}/",
        "status": {"print_stats": {"state": "standby"}},
    }, org_id=5)

    assert changed is False
    assert stored[f"mr:org:5:status:{U1_URL}"]["u1_filaments"] == U1_SLOTS


def test_u1_color_change_pushes_fresh_printer_snapshot(monkeypatch):
    pushed: list[int] = []

    monkeypatch.setattr(tunnel, "_handle_status_push", lambda _data, _org_id: True)

    async def fake_broadcast(org_id: int) -> None:
        pushed.append(org_id)

    monkeypatch.setattr("app.api.ws.broadcast_printer_snapshot", fake_broadcast)

    asyncio.run(tunnel.handle_agent_message({"type": "STATUS_PUSH"}, org_id=5))

    assert pushed == [5]
