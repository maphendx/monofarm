from __future__ import annotations

from types import SimpleNamespace

from app.models.organization import Organization
from app.services import print_tracker


class _PrinterQuery:
    def __init__(self, printers: list[SimpleNamespace]) -> None:
        self._printers = printers

    def filter(self, *args, **kwargs):
        return self

    def all(self):
        return self._printers


class _PrinterDb:
    def __init__(self, printers: list[SimpleNamespace]) -> None:
        self._printers = printers

    def query(self, *args, **kwargs):
        return _PrinterQuery(self._printers)

    def commit(self):
        return None


def test_paused_with_error_finishes_as_failed(monkeypatch):
    org = Organization(id=1, name="Org", slug="org")
    printer = SimpleNamespace(id=7, name="A1", organization_id=1, kind=None)
    db = _PrinterDb([printer])

    print_tracker._prev.clear()
    print_tracker._prev[printer.id] = {"state": "printing", "file": "benchy.3mf"}

    monkeypatch.setattr(print_tracker, "_current_state", lambda row: {"state": "paused", "file": "benchy.3mf", "error_msg": "SD card error"})
    monkeypatch.setattr(print_tracker, "_active_dispatch_job", lambda db, row: None)

    finalized: list[str] = []
    notifications: list[dict] = []

    monkeypatch.setattr(print_tracker, "_finalize_print", lambda db, row, now, result: finalized.append(result))
    monkeypatch.setattr(
        print_tracker,
        "send_print_event_notification",
        lambda *args, **kwargs: notifications.append(kwargs) or 1,
    )

    print_tracker._check_org(db, org)

    assert finalized == ["failed"]
    assert len(notifications) == 1
    notif = notifications[0]
    assert notif["event"] == "failed"
    assert notif["printer_name"] == "A1"
    assert notif["printer_id"] == printer.id
    assert notif["file_name"] == "benchy.3mf"
    assert notif["reason"] == "SD card error"
    assert notif["dedupe_key"].startswith("7:failed:benchy.3mf:")


def test_paused_without_error_stays_open(monkeypatch):
    org = Organization(id=1, name="Org", slug="org")
    printer = SimpleNamespace(id=8, name="A1", organization_id=1, kind=None)
    db = _PrinterDb([printer])

    print_tracker._prev.clear()
    print_tracker._prev[printer.id] = {"state": "printing", "file": "benchy.3mf"}

    monkeypatch.setattr(print_tracker, "_current_state", lambda row: {"state": "paused", "file": "benchy.3mf"})
    monkeypatch.setattr(print_tracker, "_active_dispatch_job", lambda db, row: None)

    finalized: list[str] = []
    notifications: list[dict] = []

    monkeypatch.setattr(print_tracker, "_finalize_print", lambda db, row, now, result: finalized.append(result))
    monkeypatch.setattr(
        print_tracker,
        "send_print_event_notification",
        lambda *args, **kwargs: notifications.append(kwargs) or 1,
    )

    print_tracker._check_org(db, org)

    assert finalized == []
    assert notifications == []
    assert print_tracker._prev[printer.id]["state"] == "paused"
