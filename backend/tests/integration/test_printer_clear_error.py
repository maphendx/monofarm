from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.printer import Printer, PrinterKind
from app.services import bambu


def test_bambu_error_cleared_flag_forces_paused_despite_stale_error_telemetry(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
):
    """Regression: once the operator dismisses the error, the printer must show
    paused (not error) even if Bambu MQTT keeps re-reporting the old error —
    the printer itself must not need to do anything for this to hold.
    """
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu-Err-01",
        kind=PrinterKind.bambu,
        bambu_dev_id="DEV-ERR-FLAG",
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)

    monkeypatch.setattr(
        bambu, "get_cached_state",
        lambda _dev_id: {"state": "error", "filename": "broken.gcode", "error_msg": "MicroSD error"},
    )
    monkeypatch.setattr(bambu, "clear_print_error", lambda _dev_id: None)

    clear_response = client.post(f"/api/printers/{printer.id}/print/clear-error", headers=auth_headers)
    assert clear_response.status_code == 200

    get_response = client.get(f"/api/printers/{printer.id}", headers=auth_headers)
    assert get_response.status_code == 200
    body = get_response.json()
    assert body["state"] == "paused"
    assert body["error_msg"] is None


def test_bambu_error_cleared_flag_resets_once_a_new_print_is_running(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
):
    """The flag must not linger and hide a genuinely new active print."""
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu-Err-02",
        kind=PrinterKind.bambu,
        bambu_dev_id="DEV-ERR-RESET",
        is_active=True,
        error_cleared_at=datetime.now(timezone.utc),
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

    db_session.refresh(printer)
    assert printer.error_cleared_at is None


def test_clear_error_succeeds_even_if_bambu_command_fails(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
):
    """The operator-visible dismiss must not depend on the hardware command."""
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu-Err-03",
        kind=PrinterKind.bambu,
        bambu_dev_id="DEV-ERR-HW-FAIL",
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)

    def _boom(_dev_id):
        raise bambu.BambuError("MQTT publish failed")

    monkeypatch.setattr(bambu, "clear_print_error", _boom)

    response = client.post(f"/api/printers/{printer.id}/print/clear-error", headers=auth_headers)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "action": "clear_error"}

    db_session.refresh(printer)
    assert printer.error_cleared_at is not None
