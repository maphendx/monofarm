"""Integration tests for print_costing.finalize_print — universal costing service."""
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.models.filament import Filament, FilamentLog
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.models.printer_slot import PrinterSlot, SlotState
from app.services.print_costing import finalize_print


@pytest.fixture
def u1_printer(db_session: Session, test_org):
    p = Printer(
        organization_id=test_org.id,
        name="U1-01",
        kind=PrinterKind.snapmaker_u1,
        moonraker_url="http://192.168.1.10:7125",
    )
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


@pytest.fixture
def bambu_printer(db_session: Session, test_org):
    p = Printer(
        organization_id=test_org.id,
        name="P1S-01",
        kind=PrinterKind.bambu,
        bambu_dev_id="BAMBU001",
    )
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


@pytest.fixture
def loaded_filament(db_session: Session, test_org):
    f = Filament(
        organization_id=test_org.id,
        material="PLA",
        color="Red",
        hex_color="#FF0000",
        brand="eSUN",
        grams_remaining=1000,
        cost_per_kg=15000,
    )
    db_session.add(f)
    db_session.commit()
    db_session.refresh(f)
    return f


@pytest.fixture
def slot_with_filament(db_session: Session, u1_printer, loaded_filament):
    slot = PrinterSlot(
        printer_id=u1_printer.id,
        slot_index=0,
        filament_id=loaded_filament.id,
        material="PLA",
        state=SlotState.loaded,
    )
    db_session.add(slot)
    db_session.commit()
    db_session.refresh(slot)
    return slot


@pytest.fixture
def in_progress_history(db_session: Session, test_org, u1_printer):
    h = PrintHistory(
        organization_id=test_org.id,
        printer_id=u1_printer.id,
        printer_name=u1_printer.name,
        file_name="test.gcode",
        started_at=datetime(2026, 6, 9, 10, 0, 0, tzinfo=timezone.utc),
        result="in_progress",
        filament_g=50.0,
    )
    db_session.add(h)
    db_session.commit()
    db_session.refresh(h)
    return h


def test_finalize_sets_result_and_duration(db_session: Session, u1_printer, in_progress_history, monkeypatch):
    monkeypatch.setattr(
        "app.services.moonraker.get_remote_file_meta", lambda *a, **kw: {}
    )
    now = datetime(2026, 6, 9, 11, 30, 0, tzinfo=timezone.utc)
    finalize_print(db_session, in_progress_history, u1_printer, "completed", now=now)
    assert in_progress_history.result == "completed"
    assert in_progress_history.duration_minutes == 90
    assert in_progress_history.printer_kind == "snapmaker_u1"


def test_finalize_deducts_filament_grams(
    db_session: Session, u1_printer, in_progress_history, slot_with_filament, loaded_filament, monkeypatch
):
    monkeypatch.setattr(
        "app.services.moonraker.get_remote_file_meta", lambda *a, **kw: {"used_g": [50.0]}
    )
    now = datetime(2026, 6, 9, 11, 0, 0, tzinfo=timezone.utc)
    finalize_print(db_session, in_progress_history, u1_printer, "completed", now=now)
    # Do not refresh — changes are in-session, not yet committed; check in-memory state
    assert loaded_filament.grams_remaining == 950


def test_finalize_writes_filament_log(
    db_session: Session, u1_printer, in_progress_history, slot_with_filament, loaded_filament, monkeypatch
):
    monkeypatch.setattr(
        "app.services.moonraker.get_remote_file_meta", lambda *a, **kw: {"used_g": [50.0]}
    )
    now = datetime(2026, 6, 9, 11, 0, 0, tzinfo=timezone.utc)
    finalize_print(db_session, in_progress_history, u1_printer, "completed", now=now)
    log_entry = db_session.query(FilamentLog).filter(
        FilamentLog.filament_id == loaded_filament.id,
        FilamentLog.reason == f"print_history:{in_progress_history.id}:slot0",
    ).first()
    assert log_entry is not None
    assert log_entry.delta_grams == -50


def test_finalize_calculates_material_cost(
    db_session: Session, u1_printer, in_progress_history, slot_with_filament, loaded_filament, monkeypatch
):
    monkeypatch.setattr(
        "app.services.moonraker.get_remote_file_meta", lambda *a, **kw: {"used_g": [50.0]}
    )
    now = datetime(2026, 6, 9, 11, 0, 0, tzinfo=timezone.utc)
    finalize_print(db_session, in_progress_history, u1_printer, "completed", now=now)
    # 50g / 1000 * 15000 UAH/kg = 750 UAH
    assert in_progress_history.material_cost == Decimal("750.000") or in_progress_history.material_cost == pytest.approx(750, abs=1)


def test_finalize_is_idempotent(
    db_session: Session, u1_printer, in_progress_history, slot_with_filament, loaded_filament, monkeypatch
):
    """Calling finalize_print twice must not double-deduct."""
    monkeypatch.setattr(
        "app.services.moonraker.get_remote_file_meta", lambda *a, **kw: {"used_g": [50.0]}
    )
    now = datetime(2026, 6, 9, 11, 0, 0, tzinfo=timezone.utc)
    finalize_print(db_session, in_progress_history, u1_printer, "completed", now=now)
    db_session.commit()
    # Reset result to in_progress to simulate second call on same entry
    in_progress_history.result = "in_progress"
    finalize_print(db_session, in_progress_history, u1_printer, "completed", now=now)

    db_session.refresh(loaded_filament)
    assert loaded_filament.grams_remaining == 950  # still 950, not 900

    log_count = db_session.query(FilamentLog).filter(
        FilamentLog.reason == f"print_history:{in_progress_history.id}:slot0"
    ).count()
    assert log_count == 1


def test_finalize_noop_if_already_done(
    db_session: Session, u1_printer, in_progress_history, loaded_filament, monkeypatch
):
    monkeypatch.setattr(
        "app.services.moonraker.get_remote_file_meta", lambda *a, **kw: {}
    )
    in_progress_history.result = "completed"
    finalize_print(db_session, in_progress_history, u1_printer, "completed")
    # Should not change grams
    db_session.refresh(loaded_filament)
    assert loaded_filament.grams_remaining == 1000


def test_finalize_populates_slots_used(
    db_session: Session, u1_printer, in_progress_history, slot_with_filament, loaded_filament, monkeypatch
):
    monkeypatch.setattr(
        "app.services.moonraker.get_remote_file_meta", lambda *a, **kw: {"used_g": [30.0]}
    )
    now = datetime(2026, 6, 9, 11, 0, 0, tzinfo=timezone.utc)
    finalize_print(db_session, in_progress_history, u1_printer, "completed", now=now)
    assert in_progress_history.slots_used is not None
    assert len(in_progress_history.slots_used) == 1
    assert in_progress_history.slots_used[0]["slot_index"] == 0
    assert in_progress_history.slots_used[0]["grams"] == 30.0
