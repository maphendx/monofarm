from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.printer import Printer, PrinterKind


def _manual_printer(db_session: Session, org_id: int, *, manual_status: str | None = None, manual_job: str | None = None) -> Printer:
    printer = Printer(
        organization_id=org_id,
        name="Manual-01",
        kind=PrinterKind.other,
        is_active=True,
        manual_status=manual_status,
        manual_job=manual_job,
    )
    db_session.add(printer)
    db_session.commit()
    db_session.refresh(printer)
    return printer


def test_clear_error_on_manual_printer_goes_to_idle_not_paused(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
):
    """Regression: manual printers have no live telemetry to auto-correct a
    stuck "paused" later, and pause/resume/cancel used to 400 for them — idle
    is the only display state guaranteed to be recoverable.
    """
    printer = _manual_printer(db_session, test_org.id, manual_status="error")

    response = client.post(f"/api/printers/{printer.id}/print/clear-error", headers=auth_headers)
    assert response.status_code == 200

    db_session.refresh(printer)
    assert printer.manual_status == "idle"


def test_resume_unsticks_a_manual_printer_stuck_paused_with_no_job(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
):
    """Regression: a manual printer with no active job stuck at "paused" must
    be recoverable via the Resume button instead of 400ing forever.
    """
    printer = _manual_printer(db_session, test_org.id, manual_status="paused", manual_job=None)

    response = client.post(f"/api/printers/{printer.id}/print/resume", headers=auth_headers)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "action": "resume"}

    db_session.refresh(printer)
    assert printer.manual_status == "idle"


def test_cancel_resets_a_manual_printer_to_idle(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
):
    printer = _manual_printer(db_session, test_org.id, manual_status="paused", manual_job="stuck.gcode")

    response = client.post(f"/api/printers/{printer.id}/print/cancel", headers=auth_headers)
    assert response.status_code == 200

    db_session.refresh(printer)
    assert printer.manual_status == "idle"
    assert printer.manual_job is None


def test_pause_sets_manual_printer_to_paused(
    db_session: Session,
    client: TestClient,
    auth_headers: dict[str, str],
    test_org,
):
    printer = _manual_printer(db_session, test_org.id, manual_status="idle")

    response = client.post(f"/api/printers/{printer.id}/print/pause", headers=auth_headers)
    assert response.status_code == 200

    db_session.refresh(printer)
    assert printer.manual_status == "paused"
