from datetime import datetime, timezone
from unittest.mock import MagicMock

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.printer import Printer, PrinterKind
from app.services import bambu, cache, moonraker


def test_clear_bed_for_moonraker_does_not_send_unreliable_home_command(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
):
    printer = Printer(
        organization_id=test_org.id,
        name="Klipper-01",
        kind=PrinterKind.other,
        moonraker_url="http://192.168.1.20:7125",
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)

    send_gcode = MagicMock()
    monkeypatch.setattr(moonraker, "send_gcode", send_gcode)
    monkeypatch.setattr(cache, "cache_get", lambda _key: None)
    monkeypatch.setattr(cache, "cache_set", lambda _key, _value, _ttl: None)

    response = client.post(
        f"/api/printers/{printer.id}/print/clear-bed",
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "action": "clear_bed"}
    send_gcode.assert_not_called()


def test_bambu_bed_cleared_flag_forces_idle_despite_stale_finish_telemetry(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
):
    """Regression: once the operator confirms bed cleared, the printer must show
    idle even if Bambu MQTT keeps re-reporting the old finished job — the
    printer itself must not need to do anything for this to hold.
    """
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu-01",
        kind=PrinterKind.bambu,
        bambu_dev_id="DEV-CLEAR-FLAG",
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)

    monkeypatch.setattr(
        bambu, "get_cached_state",
        lambda _dev_id: {"state": "operational", "filename": "done.gcode", "progress_pct": 100},
    )

    clear_response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers)
    assert clear_response.status_code == 200

    get_response = client.get(f"/api/printers/{printer.id}", headers=auth_headers)
    assert get_response.status_code == 200
    body = get_response.json()
    assert body["state"] == "idle"
    assert body["job"] is None
    assert body["progress_pct"] is None


def test_bambu_bed_cleared_flag_resets_once_a_new_print_is_running(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
):
    """The flag must not linger and hide a genuinely new active print."""
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu-02",
        kind=PrinterKind.bambu,
        bambu_dev_id="DEV-CLEAR-RESET",
        is_active=True,
        bed_cleared_at=datetime.now(timezone.utc),
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)

    monkeypatch.setattr(
        bambu, "get_cached_state",
        lambda _dev_id: {"state": "printing", "filename": "new-job.gcode", "progress_pct": 5},
    )

    get_response = client.get(f"/api/printers/{printer.id}", headers=auth_headers)
    assert get_response.status_code == 200
    body = get_response.json()
    assert body["state"] == "printing"
    assert body["job"] == "new-job.gcode"

    db_session.refresh(printer)
    assert printer.bed_cleared_at is None
