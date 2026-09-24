"""Physical spool inventory: reservations, pre-flight validation, receiving,
reconciliation. Backend-authoritative material checks for dispatched prints.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.models.bambu_cloud_job import BambuCloudJob
from app.models.filament import Filament, FilamentLog
from app.models.filament_reservation import FilamentReservation
from app.models.gcode_file import GcodeFile
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.models.printer_slot import PrinterSlot
from app.models.warehouse import Product, StockEntry, Warehouse, WarehouseType
from app.services import filament_inventory, filament_reservations, print_costing
from uuid import uuid4


def _printer(db_session, org, kind=PrinterKind.snapmaker_u1, url=None):
    printer = Printer(organization_id=org.id, name="U1-inv", kind=kind,
                      moonraker_url=url, is_active=True)
    db_session.add(printer)
    db_session.flush()
    return printer


def _spool(db_session, org, material="PLA", color="Black", grams=500, product=None, status="in_stock"):
    fil = Filament(organization_id=org.id, material=material, color=color,
                   grams_remaining=grams, warehouse_product_id=product.id if product else None,
                   status=status)
    db_session.add(fil)
    db_session.flush()
    fil.label_id = fil.label_id or "TST1"
    db_session.flush()
    return fil


def _slot(db_session, printer, index, fil):
    db_session.add(PrinterSlot(printer_id=printer.id, slot_index=index,
                               state="loaded", filament_id=fil.id))
    db_session.flush()


def _file(db_session, org, used_g=(300,), types=("PLA",)):
    row = GcodeFile(organization_id=org.id, original_name="part.gcode",
                    stored_name=f"uuid-{uuid4().hex}", size_bytes=1024,
                    filament_meta={"used_g": list(used_g), "types": list(types)})
    db_session.add(row)
    db_session.flush()
    return row


# ── availability ─────────────────────────────────────────────────────────────


def test_available_is_remaining_minus_active_reservations(db_session, test_org):
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=500)
    _slot(db_session, printer, 0, spool)
    job = BambuCloudJob(organization_id=test_org.id, printer_id=printer.id,
                        file_name="x.gcode", correlation_id="c1", idempotency_key="k1")
    db_session.add(job)
    db_session.flush()
    filament_reservations.reserve_for_job(
        db_session, test_org.id, job.id, {0: 300.0}, filament_by_slot={0: spool.id},
    )

    assert filament_inventory.available_grams(db_session, spool) == 200
    assert filament_inventory.active_reserved_g(db_session, spool.id) == 300


def test_released_reservation_restores_availability(db_session, test_org):
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=500)
    job = BambuCloudJob(organization_id=test_org.id, printer_id=printer.id,
                        correlation_id="c2", idempotency_key="k2")
    db_session.add(job)
    db_session.flush()
    filament_reservations.reserve_for_job(
        db_session, test_org.id, job.id, {0: 300.0}, filament_by_slot={0: spool.id},
    )
    filament_reservations.release_for_job(db_session, job.id)

    assert filament_inventory.available_grams(db_session, spool) == 500


def test_reservation_create_is_idempotent(db_session, test_org):
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=500)
    job = BambuCloudJob(organization_id=test_org.id, printer_id=printer.id,
                        correlation_id="c3", idempotency_key="k3")
    db_session.add(job)
    db_session.flush()
    first = filament_reservations.reserve_for_job(
        db_session, test_org.id, job.id, {0: 200.0}, filament_by_slot={0: spool.id},
    )
    second = filament_reservations.reserve_for_job(
        db_session, test_org.id, job.id, {0: 200.0}, filament_by_slot={0: spool.id},
    )
    assert (first, second) == (1, 0)
    assert filament_inventory.active_reserved_g(db_session, spool.id) == 200


def test_over_reservation_is_refused(db_session, test_org):
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=500)
    job_a = BambuCloudJob(organization_id=test_org.id, printer_id=printer.id,
                          correlation_id="c4", idempotency_key="k4")
    job_b = BambuCloudJob(organization_id=test_org.id, printer_id=printer.id,
                          correlation_id="c5", idempotency_key="k5")
    db_session.add_all([job_a, job_b])
    db_session.flush()
    filament_reservations.reserve_for_job(
        db_session, test_org.id, job_a.id, {0: 400.0}, filament_by_slot={0: spool.id},
    )
    created = filament_reservations.reserve_for_job(
        db_session, test_org.id, job_b.id, {0: 400.0}, filament_by_slot={0: spool.id},
    )
    assert created == 0
    assert filament_inventory.active_reserved_g(db_session, spool.id) == 400


# ── finalize consumes the reservation ────────────────────────────────────────


def test_finalize_consumes_reservation_and_releases_remaining_demand(
    db_session, test_org, monkeypatch,
):
    from app.services import moonraker
    monkeypatch.setattr(moonraker, "get_live_status", lambda url, org_id=None: {"state": "operational", "filename": "part.gcode"})
    monkeypatch.setattr(moonraker, "get_remote_file_meta", lambda url, filename, org_id=None: {})

    printer = _printer(db_session, test_org, url="http://u1")
    spool = _spool(db_session, test_org, grams=1000)
    _slot(db_session, printer, 0, spool)
    row = _file(db_session, test_org, used_g=(400,))
    job = BambuCloudJob(organization_id=test_org.id, printer_id=printer.id,
                        gcode_file_id=row.id, file_name="part.gcode",
                        correlation_id="c6", idempotency_key="k6")
    db_session.add(job)
    db_session.flush()
    filament_reservations.reserve_for_job(
        db_session, test_org.id, job.id, {0: 400.0}, filament_by_slot={0: spool.id},
    )
    history = PrintHistory(organization_id=test_org.id, printer_id=printer.id,
                           printer_name=printer.name, printer_kind=printer.kind.value,
                           file_name="part.gcode", result="in_progress",
                           started_at=datetime.now(timezone.utc) - timedelta0(),
                           bambu_cloud_job_id=job.id)
    db_session.add(history)
    db_session.flush()

    print_costing.finalize_print(db_session, history, printer, "completed")

    rows = db_session.query(FilamentReservation).filter_by(job_id=job.id).all()
    assert rows[0].status == "consumed"
    db_session.refresh(spool)
    assert spool.grams_remaining == 600


def timedelta0():
    from datetime import timedelta
    return timedelta(minutes=30)


# ── pre-flight ───────────────────────────────────────────────────────────────


class _Org:
    def __init__(self, org, margin=5, block=False):
        self.id = org.id
        self.filament_safety_margin_pct = margin
        self.preflight_block_dispatch = block


def test_preflight_passes_with_margin(db_session, test_org):
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=500, material="PLA")
    _slot(db_session, printer, 0, spool)
    rows = filament_inventory.preflight_for_print(
        db_session, _Org(test_org, margin=5), printer,
        {0: {"grams": 300, "material": "PLA"}},
    )
    assert rows[0].status == "ok"
    assert rows[0].required_g == 315


def test_preflight_warns_without_margin_room(db_session, test_org):
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=305)
    _slot(db_session, printer, 0, spool)
    rows = filament_inventory.preflight_for_print(
        db_session, _Org(test_org, margin=5), printer,
        {0: {"grams": 300, "material": "PLA"}},
    )
    assert rows[0].status == "warn"


def test_preflight_blocks_shortage_and_suggests_candidates(db_session, test_org):
    printer = _printer(db_session, test_org)
    loaded = _spool(db_session, test_org, grams=200, material="PLA")
    warehouse_spool = _spool(db_session, test_org, grams=800, material="PLA")
    _slot(db_session, printer, 0, loaded)
    rows = filament_inventory.preflight_for_print(
        db_session, _Org(test_org, margin=5), printer,
        {0: {"grams": 400, "material": "PLA"}},
    )
    assert rows[0].status == "blocked"
    assert any(c.filament_id == warehouse_spool.id for c in rows[0].suggestions)


def test_preflight_blocks_material_mismatch(db_session, test_org):
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=1000, material="PETG")
    _slot(db_session, printer, 0, spool)
    rows = filament_inventory.preflight_for_print(
        db_session, _Org(test_org), printer,
        {0: {"grams": 100, "material": "PLA"}},
    )
    assert rows[0].status == "blocked"
    assert "не збігається" in (rows[0].reason or "")


def test_preflight_reports_unmapped_slot(db_session, test_org):
    printer = _printer(db_session, test_org)
    rows = filament_inventory.preflight_for_print(
        db_session, _Org(test_org), printer,
        {0: {"grams": 100, "material": "PLA"}},
    )
    assert rows[0].status == "unmapped"


def test_preflight_excludes_own_reservation_when_rechecking(db_session, test_org):
    """Re-validating a dispatched job must not count its own reservation."""
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=500)
    _slot(db_session, printer, 0, spool)
    job = BambuCloudJob(organization_id=test_org.id, printer_id=printer.id,
                        correlation_id="c7", idempotency_key="k7")
    db_session.add(job)
    db_session.flush()
    filament_reservations.reserve_for_job(
        db_session, test_org.id, job.id, {0: 300.0}, filament_by_slot={0: spool.id},
    )
    # Generic check sees 200 available...
    assert filament_inventory.available_grams(db_session, spool) == 200
    # ...the dispatched job itself still fits (its own 300 g are the demand).
    rows = filament_inventory.preflight_for_print(
        db_session, _Org(test_org), printer,
        {0: {"grams": 300, "material": "PLA"}},
    )
    assert rows[0].status == "blocked"  # honest: another job took 300 → nothing free
    assert rows[0].available_g == 200


# ── receiving spools ─────────────────────────────────────────────────────────


def test_receive_creates_one_movement_and_n_spools(db_session, test_org):

    from app.api.filaments import receive_spools
    from app.schemas.filament import SpoolReceivePayload, SpoolReceiveItem

    class _User:
        id = None

    wh = Warehouse(organization_id=test_org.id, name="Сировина", type=WarehouseType.raw)
    product = Product(organization_id=test_org.id, name="Bambu · PLA · Чорний", sku="MAT-PLA-B", unit="г")
    test_org.plan = "farm"
    db_session.add_all([wh, product])
    db_session.commit()

    created = receive_spools(
        SpoolReceivePayload(
            product_id=product.id, warehouse_id=wh.id,
            spools=[SpoolReceiveItem(grams=1000, count=3)],
        ),
        db=db_session, org=test_org, user=_User(),
    )
    assert len(created) == 3
    rows = db_session.query(Filament).filter(Filament.id.in_([f.id for f in created])).all()
    assert all(f.warehouse_product_id == product.id for f in rows)
    assert all(f.material == "PLA" and f.color == "Чорний" for f in rows)
    assert all(f.label_id for f in rows)
    movements = db_session.query(
        __import__("app.models.warehouse", fromlist=["WarehouseMovement"]).WarehouseMovement
    ).filter_by(product_id=product.id).all()
    assert len(movements) == 1
    assert float(movements[0].quantity) == 3000
    entry = db_session.query(StockEntry).one()
    assert float(entry.quantity) == 3000
    logs = db_session.query(FilamentLog).filter(FilamentLog.delta_grams > 0).all()
    assert len(logs) == 3


# ── reconciliation ───────────────────────────────────────────────────────────


def test_reconciliation_exposes_discrepancy(db_session, test_org):
    wh = Warehouse(organization_id=test_org.id, name="Сировина", type=WarehouseType.raw)
    product = Product(organization_id=test_org.id, name="PLA Black", sku="MAT-1", unit="г")
    db_session.add_all([wh, product])
    db_session.flush()
    db_session.add(StockEntry(organization_id=test_org.id, product_id=product.id,
                              warehouse_id=wh.id, quantity=Decimal("18432")))
    _spool(db_session, test_org, grams=18280, product=product)
    db_session.flush()

    report = filament_inventory.reconciliation(db_session, test_org.id)
    row = next(r for r in report if r.product_id == product.id)
    assert row.ledger_g == 18432
    assert row.spools_g == 18280
    assert row.difference_g == -152


# ── spool status ─────────────────────────────────────────────────────────────


def test_empty_spool_is_blocked_in_preflight(db_session, test_org):
    printer = _printer(db_session, test_org)
    spool = _spool(db_session, test_org, grams=0, status="empty")
    _slot(db_session, printer, 0, spool)
    rows = filament_inventory.preflight_for_print(
        db_session, _Org(test_org), printer,
        {0: {"grams": 100, "material": "PLA"}},
    )
    assert rows[0].status == "blocked"
    assert "порожньою" in (rows[0].reason or "")
