"""Spool ↔ warehouse-material accounting.

A spool linked to a warehouse product (``Filament.warehouse_product_id``)
keeps the warehouse ledger in sync with physical consumption. Every gram
change goes through the canonical ``_apply_movement`` — stock fields are
never touched directly. Products and warehouses are never auto-created:
without an explicit link and existing book stock, the change is spool-only
and the discrepancy is logged.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models.filament import Filament

log = logging.getLogger(__name__)


def write_off_warehouse_material(
    db: "Session",
    org_id: int,
    filament: "Filament",
    grams: int,
    reason: str,
    *,
    user_id: int | None = None,
    print_history_id: int | None = None,
) -> bool:
    """Write off consumed grams from the linked warehouse product.

    Idempotent by ``reason`` (same deterministic key as the spool deduction).
    When the linked product has no book stock to deduct from, the discrepancy
    is logged and the movement skipped — the spool keeps the physical truth.
    Returns True when a movement was created.
    """
    from decimal import Decimal as _Decimal

    from app.models.warehouse import (
        MovementType, Product, WarehouseMovement,
    )
    from app.services.print_accounting import DISCREPANCY_LOG_PREFIX

    if grams <= 0:
        return False
    if not filament.warehouse_product_id:
        return False
    product = db.query(Product).filter_by(
        id=filament.warehouse_product_id, organization_id=org_id,
    ).first()
    if product is None or not product.is_active:
        log.warning(
            "%s spool=%s links to missing/archived product=%s — warehouse write-off skipped",
            DISCREPANCY_LOG_PREFIX, filament.id, filament.warehouse_product_id,
        )
        return False

    duplicate = db.query(WarehouseMovement.id).filter(
        WarehouseMovement.organization_id == org_id,
        WarehouseMovement.type == MovementType.WRITE_OFF,
        WarehouseMovement.reason == reason,
    ).first()
    if duplicate:
        log.info("print_accounting: skip duplicate warehouse write-off reason=%s", reason)
        return False

    entry = material_stock_entry(db, org_id, filament)
    if entry is None or entry.quantity <= 0:
        log.warning(
            "%s product=%s has no book stock for %.0fg write-off (reason=%s) — "
            "spool deducted, warehouse skipped. Record the material via PURCHASE_IN.",
            DISCREPANCY_LOG_PREFIX, product.id, grams, reason,
        )
        return False
    factor = grams_per_unit(product.unit)
    qty = min(_Decimal(grams) / factor, entry.quantity)
    if qty * factor < _Decimal(str(grams)):
        log.warning(
            "%s product=%s book stock %.0fg < consumed %.0fg — clamped write-off (reason=%s)",
            DISCREPANCY_LOG_PREFIX, product.id, float(entry.quantity), grams, reason,
        )

    unit_cost = (
        _Decimal(str(filament.cost_per_kg)) / _Decimal("1000") * factor
        if filament.cost_per_kg else None
    )
    movement = WarehouseMovement(
        organization_id=org_id,
        type=MovementType.WRITE_OFF,
        product_id=product.id,
        warehouse_from_id=entry.warehouse_id,
        quantity=qty,
        unit=product.unit,
        unit_cost=unit_cost,
        total_cost=(qty * unit_cost) if unit_cost else None,
        reason=reason,
        created_by_id=user_id,
        print_history_id=print_history_id,
    )
    db.add(movement)
    db.flush()
    from app.api.warehouse_modules.common import _apply_movement
    _apply_movement(movement, db)
    log.info(
        "print_accounting: warehouse WRITE_OFF product=%s grams=%s reason=%s",
        product.id, qty, reason,
    )
    return True


def spool_cost(filament: "Filament", grams: float) -> Decimal | None:
    """Material cost of ``grams`` from this spool, or None when unknown."""
    if not filament.cost_per_kg or grams <= 0:
        return None
    return Decimal(str(round(grams, 3))) / Decimal("1000") * Decimal(str(filament.cost_per_kg))


def grams_per_unit(unit: str) -> Decimal:
    from fastapi import HTTPException
    normalized = unit.strip().lower()
    if normalized in ("г", "g", "gram", "grams"):
        return Decimal(1)
    if normalized in ("кг", "kg"):
        return Decimal(1000)
    raise HTTPException(422, "Для пластику оберіть одиницю товару г або кг")


def material_stock_entry(db, org_id, filament):
    """Never guess a warehouse when a legacy spool has multiple locations."""
    from app.models.warehouse import StockEntry
    query = db.query(StockEntry).filter_by(
        organization_id=org_id, product_id=filament.warehouse_product_id,
    )
    if filament.warehouse_id is not None:
        return query.filter_by(warehouse_id=filament.warehouse_id).with_for_update().first()
    entries = query.filter(StockEntry.quantity > 0).order_by(StockEntry.warehouse_id).with_for_update().all()
    if len(entries) == 1:
        filament.warehouse_id = entries[0].warehouse_id
        return entries[0]
    return None


def adjust_remaining(db, org_id, filament, new_grams, *, user_id, reason=None, task_id=None):
    """One correction transaction for physical spool and warehouse ledger."""
    from fastapi import HTTPException
    from app.models.filament import FilamentLog
    from app.models.warehouse import Product, WarehouseMovement, MovementType
    from app.api.warehouse_modules.common import _apply_movement
    from app.services.telegram_notify import notify_filament_low_if_crossed

    previous = filament.grams_remaining
    delta = new_grams - previous
    if not delta:
        return
    if new_grams < 0:
        raise HTTPException(422, "Залишок не може бути від’ємним")
    if filament.warehouse_product_id:
        product = db.query(Product).filter_by(id=filament.warehouse_product_id, organization_id=org_id).first()
        if product is None:
            raise HTTPException(409, "Не знайдено складський матеріал")
        factor = grams_per_unit(product.unit)
        entry = material_stock_entry(db, org_id, filament)
        if filament.warehouse_id is None:
            raise HTTPException(409, "Вкажіть склад котушки перед коригуванням")
        quantity = Decimal(abs(delta)) / factor
        if delta < 0 and (entry is None or entry.quantity < quantity):
            raise HTTPException(409, "Залишок складу розходиться з котушкою. Спочатку звірте склад")
        movement = WarehouseMovement(
            organization_id=org_id, type=MovementType.ADJUSTMENT,
            product_id=product.id, quantity=quantity, unit=product.unit,
            warehouse_from_id=filament.warehouse_id if delta < 0 else None,
            warehouse_to_id=filament.warehouse_id if delta > 0 else None,
            reason=f"Котушка {filament.label_id or filament.id}: {reason or 'Уточнення залишку'}"[:255],
            created_by_id=user_id,
        )
        db.add(movement)
        db.flush()
        _apply_movement(movement, db)
    filament.grams_remaining = new_grams
    filament.status = "empty" if new_grams == 0 else "in_stock"
    db.add(FilamentLog(
        organization_id=org_id, filament_id=filament.id, delta_grams=delta,
        grams_after=new_grams, reason=reason or "Уточнення залишку", user_id=user_id, task_id=task_id,
    ))
    notify_filament_low_if_crossed(db, org_id, filament, prev_grams=previous)
