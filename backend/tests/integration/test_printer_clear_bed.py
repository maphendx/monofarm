from unittest.mock import MagicMock

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.printer import Printer, PrinterKind
from app.services import cache, moonraker


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
