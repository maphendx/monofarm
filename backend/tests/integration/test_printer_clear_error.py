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


def test_bambu_error_cleared_flag_does_not_force_paused_on_an_idle_printer(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
):
    """Regression: a printer with no active print must never be shown as
    "paused" just because it had an error dismissed at some earlier point and
    hasn't printed again since — the flag must not linger past the error.
    """
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu-Err-04",
        kind=PrinterKind.bambu,
        bambu_dev_id="DEV-ERR-IDLE",
        is_active=True,
        error_cleared_at=datetime.now(timezone.utc),
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)

    monkeypatch.setattr(bambu, "get_cached_state", lambda _dev_id: {"state": "idle", "filename": None})

    get_response = client.get(f"/api/printers/{printer.id}", headers=auth_headers)
    assert get_response.status_code == 200
    body = get_response.json()
    assert body["state"] == "idle"
    assert body["job"] is None

    db_session.refresh(printer)
    assert printer.error_cleared_at is None


def test_cancel_unsticks_a_bambu_printer_permanently_stuck_reporting_failed(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
    monkeypatch,
):
    """Regression: a print that fails outright (e.g. FAILED at layer 0) can
    stay reported that way indefinitely — Bambu firmware doesn't self-clear
    it without a new print or a physical touchscreen tap. error_cleared_at
    alone just keeps forcing "paused" forever with no escape. Cancel must be
    a guaranteed way out regardless of what live telemetry still says.
    """
    printer = Printer(
        organization_id=test_org.id,
        name="Bambu-Err-05",
        kind=PrinterKind.bambu,
        bambu_dev_id="DEV-ERR-STUCK",
        is_active=True,
        error_cleared_at=datetime.now(timezone.utc),
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)

    monkeypatch.setattr(
        bambu, "get_cached_state",
        lambda _dev_id: {"state": "error", "raw_state": "FAILED", "filename": "broken.gcode", "progress_pct": 0},
    )
    monkeypatch.setattr(bambu, "stop_print", lambda _dev_id: None)

    cancel_response = client.post(f"/api/printers/{printer.id}/print/cancel", headers=auth_headers)
    assert cancel_response.status_code == 200

    get_response = client.get(f"/api/printers/{printer.id}", headers=auth_headers)
    assert get_response.status_code == 200
    body = get_response.json()
    assert body["state"] == "idle"
    assert body["job"] is None

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
