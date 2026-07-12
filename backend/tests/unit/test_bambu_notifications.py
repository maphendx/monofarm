from __future__ import annotations

from types import SimpleNamespace

from app.services import bambu


class _Query:
    def __init__(self, printer):
        self._printer = printer

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._printer


class _FakeDb:
    def __init__(self, printer):
        self._printer = printer

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def query(self, *args, **kwargs):
        return _Query(self._printer)


def test_bambu_pause_with_error_emits_failed_alert(monkeypatch):
    printer = SimpleNamespace(id=77, name="A3", organization_id=5)
    db = _FakeDb(printer)

    bambu._dev_to_org.clear()
    bambu._state_cache.clear()
    bambu._dev_to_org["DEV-1"] = 5
    bambu._state_cache["DEV-1"] = {"state": "printing", "error_msg": None, "filename": "benchy.3mf"}

    import app.core.db as db_mod
    monkeypatch.setattr(db_mod, "SessionLocal", lambda: db)
    import app.services.cache as cache_mod
    monkeypatch.setattr(cache_mod, "cache_delete", lambda *args, **kwargs: None)
    monkeypatch.setattr(cache_mod, "cache_get", lambda *args, **kwargs: None)
    monkeypatch.setattr(cache_mod, "cache_set", lambda *args, **kwargs: None)
    monkeypatch.setattr(bambu, "log_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(bambu, "_sync_cloud_job_from_report", lambda *args, **kwargs: None)

    captured: list[dict] = []
    import app.services.telegram_notify as telegram_notify
    monkeypatch.setattr(
        telegram_notify,
        "send_print_event_notification",
        lambda *args, **kwargs: captured.append(kwargs) or 1,
    )

    bambu._handle_report_payload(
        "DEV-1",
        {
            "print": {
                "gcode_state": "PAUSE",
                "subtask_name": "benchy.3mf",
                "print_error": 0x0500C010,
            }
        },
    )

    assert len(captured) == 1
    alert = captured[0]
    assert alert["event"] == "failed"
    assert alert["printer_name"] == "A3"
    assert alert["printer_id"] == 77
    assert alert["file_name"] == "benchy.3mf"
    assert "microSD" in alert["reason"]
    assert "0x0500c010" in alert["reason"].lower()
