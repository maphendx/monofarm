"""Operator workflow: receipt → mapped run → one warehouse deduction → correction."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.api.filaments import receive_spools, set_remaining
from app.models.bambu_cloud_job import BambuCloudJob
from app.models.filament import Filament, FilamentLog
from app.models.filament_reservation import FilamentReservation
from app.models.gcode_file import GcodeFile
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.models.printer_slot import PrinterSlot
from app.models.warehouse import Product, StockEntry, Warehouse, WarehouseMovement, WarehouseType
from app.schemas.filament import FilamentSetRemaining, SpoolReceiveItem, SpoolReceivePayload
from app.services.bambu_dispatch import create_cloud_job
from app.services.filament_accounting import write_off_warehouse_material
from app.services.print_costing import finalize_print


def receive(db, org, user, unit="г"):
    org.plan = "pro"
    warehouse = Warehouse(organization_id=org.id, name="Materials", type=WarehouseType.raw)
    product = Product(organization_id=org.id, sku="PLA-BLACK", name="Black PLA", unit=unit)
    db.add_all([warehouse, product])
    db.flush()
    payload = SpoolReceivePayload(product_id=product.id, warehouse_id=warehouse.id,
        spools=[SpoolReceiveItem(grams=1000, count=2)], material="PLA", color="Black",
        cost_per_kg=500, request_id="receipt-test-123")
    rows = receive_spools(payload, db=db, org=org, user=user)
    return warehouse, product, payload, rows


def test_receipt_replay_and_kg_avco(db_session, test_org, admin_user):
    db = db_session
    warehouse, product, payload, rows = receive(db, test_org, admin_user, "кг")
    replay = receive_spools(payload, db=db, org=test_org, user=admin_user)
    assert [r.id for r in rows] == [r.id for r in replay]
    assert db.query(WarehouseMovement).count() == 1
    assert db.query(StockEntry).one().quantity == Decimal(2)
    assert product.cost_price == Decimal(500)
    assert all(f.warehouse_id == warehouse.id and f.material == "PLA" for f in rows)


def test_absolute_correction_updates_both_ledgers_once(db_session, test_org, admin_user):
    db = db_session
    _, _, _, rows = receive(db, test_org, admin_user, "кг")
    payload = FilamentSetRemaining(grams_remaining=880, expected_grams=1000)
    for _ in range(2):
        result = set_remaining(rows[0].id, payload, db=db, org=test_org, user=admin_user)
        assert result.grams_remaining == 880
    assert db.query(StockEntry).one().quantity == Decimal("1.880")
    assert db.query(WarehouseMovement).count() == 2
    assert db.query(FilamentLog).filter(FilamentLog.delta_grams < 0).count() == 1
    with pytest.raises(HTTPException) as exc:
        set_remaining(rows[0].id, FilamentSetRemaining(grams_remaining=800, expected_grams=1000), db=db, org=test_org, user=admin_user)
    assert exc.value.status_code == 409


def test_print_uses_receipt_warehouse_not_largest_stock(db_session, test_org, admin_user):
    db = db_session
    warehouse, product, _, rows = receive(db, test_org, admin_user, "кг")
    other = Warehouse(organization_id=test_org.id, name="Other", type=WarehouseType.raw)
    db.add(other)
    db.flush()
    db.add(StockEntry(organization_id=test_org.id, warehouse_id=other.id, product_id=product.id, quantity=Decimal(50)))
    db.flush()
    spool = db.get(Filament, rows[0].id)
    write_off_warehouse_material(db, test_org.id, spool, 120, "print_history:999:slot0")
    assert db.query(StockEntry).filter_by(warehouse_id=warehouse.id).one().quantity == Decimal("1.880")
    assert db.query(StockEntry).filter_by(warehouse_id=other.id).one().quantity == Decimal(50)


def test_dispatch_remap_reserves_and_freezes_spool_then_deducts_once(db_session, test_org, admin_user):
    db = db_session
    _, _, _, rows = receive(db, test_org, admin_user)
    printer = Printer(organization_id=test_org.id, name="P1S", kind=PrinterKind.bambu)
    file = GcodeFile(organization_id=test_org.id, stored_name="workflow", original_name="part.gcode", size_bytes=1,
                    filament_meta={"used_g": [120], "types": ["PLA"]})
    db.add_all([printer, file])
    db.flush()
    slot = PrinterSlot(printer_id=printer.id, slot_index=2, filament_id=rows[0].id, state="loaded")
    db.add(slot)
    db.flush()
    job = create_cloud_job(db, org_id=test_org.id, printer_id=printer.id, printer_bambu_dev_id=None,
        gcode_file_id=file.id, file_name=file.original_name, region=None,
        request_payload={"ams_mapping": [2], "use_ams": True}, idempotency_key="workflow-remap")
    reservation = db.query(FilamentReservation).one()
    assert reservation.filament_id == rows[0].id
    assert reservation.reserved_g == 120
    assert job.request_payload_json["material_plan"]["2"]["filament_id"] == rows[0].id
    # Replace the spool before the tracker receives completion; edit the file too.
    slot.filament_id = rows[1].id
    file.filament_meta = {"used_g": [800]}
    history = PrintHistory(organization_id=test_org.id, printer_id=printer.id, printer_name=printer.name,
        file_name=file.original_name, bambu_cloud_job_id=job.id, result="in_progress",
        started_at=datetime.now(timezone.utc)-timedelta(minutes=20))
    db.add(history)
    db.flush()
    finalize_print(db, history, printer, "completed")
    finalize_print(db, history, printer, "completed")
    assert db.get(Filament, rows[0].id).grams_remaining == 880
    assert db.get(Filament, rows[1].id).grams_remaining == 1000
    assert db.query(StockEntry).one().quantity == 1880
    assert history.material_cost == Decimal(60)
    assert reservation.status == "consumed"
    assert db.query(FilamentLog).filter(FilamentLog.delta_grams < 0).count() == 1


def test_bambu_cancelled_at_one_percent_is_not_completed(db_session, test_org, admin_user):
    db = db_session
    _, _, _, rows = receive(db, test_org, admin_user)
    printer = Printer(organization_id=test_org.id, name="P1S", kind=PrinterKind.bambu)
    db.add(printer)
    db.flush()
    plan = {"254": {"grams": 1000, "filament_id": rows[0].id, "cost_per_kg": 500}}
    job = BambuCloudJob(organization_id=test_org.id, printer_id=printer.id, correlation_id="one", idempotency_key="one",
        progress_pct=1, request_payload_json={"material_plan": plan})
    db.add(job)
    db.flush()
    history = PrintHistory(organization_id=test_org.id, printer_id=printer.id, printer_name=printer.name,
        bambu_cloud_job_id=job.id, result="in_progress", started_at=datetime.now(timezone.utc)-timedelta(minutes=2))
    db.add(history)
    db.flush()
    finalize_print(db, history, printer, "cancelled")
    assert db.get(Filament, rows[0].id).grams_remaining == 990
    assert history.filament_g == 10


def test_retired_spool_blocks_enforced_dispatch(db_session, test_org, admin_user):
    from app.services.filament_inventory import preflight_for_print
    db = db_session
    _, _, _, rows = receive(db, test_org, admin_user)
    printer = Printer(organization_id=test_org.id, name="U1", kind=PrinterKind.snapmaker_u1)
    db.add(printer)
    db.flush()
    db.add(PrinterSlot(printer_id=printer.id, slot_index=0, filament_id=rows[0].id))
    db.get(Filament, rows[0].id).status = "retired"
    db.flush()
    assert preflight_for_print(db, test_org, printer, {0: {"grams": 50, "material": "PLA"}})[0].status == "blocked"


def test_migration_backfills_only_unambiguous_spool_warehouse(db_session, test_org, admin_user):
    import importlib.util
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import text
    db = db_session
    warehouse, product, _, _ = receive(db, test_org, admin_user)
    spec = importlib.util.spec_from_file_location("spool_migration", "alembic/versions/0096_spool_warehouse_accounting.py")
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    migration.op = Operations(MigrationContext.configure(db.connection()))
    migration.downgrade()
    migration.upgrade()
    assert db.execute(text("SELECT DISTINCT warehouse_id FROM filaments WHERE organization_id = :org"), {"org": test_org.id}).scalars().all() == [warehouse.id]
    migration.downgrade()
    other_id = db.execute(text("INSERT INTO wh_warehouses (organization_id,name,type,is_active) VALUES (:org,'Other','raw',true) RETURNING id"), {"org": test_org.id}).scalar_one()
    db.execute(text("INSERT INTO wh_stock_entries (organization_id,product_id,warehouse_id,quantity,reserved_qty) VALUES (:org,:product,:warehouse,10,0)"), {"org": test_org.id, "product": product.id, "warehouse": other_id})
    migration.upgrade()
    assert db.execute(text("SELECT DISTINCT warehouse_id FROM filaments WHERE organization_id = :org"), {"org": test_org.id}).scalars().all() == [None]


def test_enforced_dispatch_cannot_reserve_the_same_grams_twice(db_session, test_org, admin_user):
    db = db_session
    _, _, _, rows = receive(db, test_org, admin_user)
    test_org.preflight_block_dispatch = True
    printer = Printer(organization_id=test_org.id, name="U1", kind=PrinterKind.snapmaker_u1)
    file = GcodeFile(organization_id=test_org.id, stored_name="reserve", original_name="part.gcode", size_bytes=1,
                    filament_meta={"used_g": [600], "types": ["PLA"]})
    db.add_all([printer, file])
    db.flush()
    db.add(PrinterSlot(printer_id=printer.id, slot_index=2, filament_id=rows[0].id, state="loaded"))
    db.flush()
    kwargs = dict(org_id=test_org.id, printer_id=printer.id, printer_bambu_dev_id=None,
        gcode_file_id=file.id, dispatch_mode="moonraker", request_payload={"slot_map": {"0": 2}})
    first = create_cloud_job(db, **kwargs, idempotency_key="reserve-first")
    assert first.request_payload_json["material_plan"]["2"]["grams"] == 600
    with pytest.raises(HTTPException) as exc:
        create_cloud_job(db, **kwargs, idempotency_key="reserve-second")
    assert exc.value.status_code == 409
    assert db.query(FilamentReservation).filter_by(status="active").count() == 1


def test_receipt_replay_rejects_changed_weight(db_session, test_org, admin_user):
    _, _, payload, _ = receive(db_session, test_org, admin_user)
    payload.spools = [SpoolReceiveItem(grams=500, count=2)]
    with pytest.raises(HTTPException) as exc:
        receive_spools(payload, db=db_session, org=test_org, user=admin_user)
    assert exc.value.status_code == 409
    assert db_session.query(WarehouseMovement).count() == 1
