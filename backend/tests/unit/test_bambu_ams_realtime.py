from app.services import bambu
from app.api.printers import _merge_bambu_filament
from app.services.ws_manager import PRINTER_EVENTS_CHANNEL


def _ams_report(*, tray_color: str = "FF0000FF", tray_now: str = "0") -> dict:
    return {
        "print": {
            "gcode_state": "IDLE",
            "ams": {
                "tray_now": tray_now,
                "ams": [
                    {
                        "id": "0",
                        "tray": [
                            {
                                "id": "0",
                                "tray_type": "PLA",
                                "tray_color": tray_color,
                                "tray_sub_brands": "Generic",
                            },
                        ],
                    },
                ],
            },
        },
    }


def test_parse_ams_detects_real_slot_changes(monkeypatch):
    bambu._ams_cache.clear()
    bambu._last_ams_redis_write.clear()
    monkeypatch.setattr("app.services.cache.cache_set", lambda *_args, **_kwargs: None)

    ams = _ams_report()["print"]["ams"]
    assert bambu._parse_ams("AMS-1", ams, None) is True
    assert bambu._parse_ams("AMS-1", ams, None) is False

    changed = _ams_report(tray_color="00FF00FF")["print"]["ams"]
    assert bambu._parse_ams("AMS-1", changed, None) is True


def test_mqtt_ams_or_active_tray_change_emits_realtime_refresh(monkeypatch):
    bambu._ams_cache.clear()
    bambu._state_cache.clear()
    bambu._last_ams_redis_write.clear()
    bambu._last_state_redis_write.clear()
    bambu._dev_to_org["AMS-2"] = 42
    events: list[tuple[str, str]] = []

    monkeypatch.setattr("app.services.cache.cache_get", lambda _key: None)
    monkeypatch.setattr("app.services.cache.cache_set", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("app.services.cache.cache_delete", lambda _key: None)
    monkeypatch.setattr(bambu, "_sync_cloud_job_from_report", lambda *_args: None)
    monkeypatch.setattr(
        bambu,
        "_publish_printer_refresh",
        lambda dev_id, reason: events.append((dev_id, reason)),
    )

    bambu._handle_report_payload("AMS-2", _ams_report())
    assert events == [("AMS-2", "ams")]

    bambu._handle_report_payload("AMS-2", _ams_report())
    assert events == [("AMS-2", "ams")]

    bambu._handle_report_payload("AMS-2", _ams_report(tray_now="1"))
    assert events == [("AMS-2", "ams"), ("AMS-2", "active_tray")]


def test_realtime_refresh_is_routed_through_redis(monkeypatch):
    published: list[tuple[str, str]] = []

    class FakeRedis:
        def publish(self, channel: str, payload: str) -> int:
            published.append((channel, payload))
            return 1

    bambu._dev_to_org["AMS-REDIS"] = 73
    monkeypatch.setattr("app.services.cache._r", lambda: FakeRedis())

    bambu._publish_printer_refresh("AMS-REDIS", "ams")

    assert published[0][0] == PRINTER_EVENTS_CHANNEL
    assert '"org_id": 73' in published[0][1]
    assert '"dev_id": "AMS-REDIS"' in published[0][1]


def test_bulk_filament_sync_requests_fresh_printer_report(monkeypatch):
    published: list[tuple[dict, int]] = []
    monkeypatch.setattr(
        bambu,
        "_publish",
        lambda _dev_id, payload, qos=0: published.append((payload, qos)),
    )

    bambu.sync_filament_slots(
        "AMS-3",
        [
            {"slot": 0, "type": "PLA", "color": "#ff0000", "empty": False},
            {"slot": 1, "empty": True},
        ],
    )

    assert [item[0]["print"]["command"] for item in published[:-1]] == [
        "ams_filament_setting",
        "ams_filament_setting",
    ]
    assert all(qos == 1 for _, qos in published)
    pushall = published[-1][0]["pushing"]
    assert pushall["command"] == "pushall"
    assert pushall["version"] == 1
    assert pushall["push_target"] == 1
    assert pushall["sequence_id"]


def test_partial_external_report_preserves_last_full_ams(monkeypatch):
    bambu._ams_cache.clear()
    bambu._last_ams_redis_write.clear()
    monkeypatch.setattr("app.services.cache.cache_get", lambda _key: None)
    monkeypatch.setattr("app.services.cache.cache_set", lambda *_args, **_kwargs: None)

    full = _ams_report()["print"]["ams"]
    assert bambu._parse_ams("AMS-PARTIAL", full, None) is True

    external = {
        "tray_type": "PETG",
        "tray_color": "00FF00FF",
        "tray_sub_brands": "Generic",
    }
    assert bambu._parse_ams("AMS-PARTIAL", {}, external) is True
    assert [slot["slot"] for slot in bambu._ams_cache["AMS-PARTIAL"]] == [0, 254]


def test_authoritative_empty_ams_report_clears_stale_slots(monkeypatch):
    bambu._ams_cache.clear()
    bambu._last_ams_redis_write.clear()
    monkeypatch.setattr("app.services.cache.cache_get", lambda _key: None)
    monkeypatch.setattr("app.services.cache.cache_set", lambda *_args, **_kwargs: None)

    full = _ams_report()["print"]["ams"]
    assert bambu._parse_ams("AMS-REMOVED", full, None) is True
    assert bambu._parse_ams("AMS-REMOVED", {"ams": []}, None) is True
    assert bambu._ams_cache["AMS-REMOVED"] == []


def test_ams_cache_outlives_periodic_full_refresh():
    assert bambu.AMS_CACHE_TTL_SECONDS > bambu.BAMBU_FULL_REFRESH_INTERVAL_SECONDS


def test_live_handy_slot_keeps_inventory_link_only_while_material_matches():
    persisted = {
        "slot": 0,
        "type": "PLA",
        "color": "#ff0000",
        "color_name": "Red",
        "filament_id": 91,
        "empty": False,
        "unit_id": 0,
    }

    same_spool = _merge_bambu_filament(
        persisted,
        {**persisted, "color": "#FF0000", "color_name": None, "filament_id": None},
    )
    assert same_spool["filament_id"] == 91
    assert same_spool["color_name"] == "Red"
    assert same_spool["verified"] is True

    changed_in_handy = _merge_bambu_filament(
        persisted,
        {**persisted, "color": "#00ff00", "color_name": None, "filament_id": None},
    )
    assert changed_in_handy["filament_id"] is None
    assert changed_in_handy["color_name"] is None
