"""Physical spool inventory — availability, location, reconciliation, candidates.

One canonical source for every "how much material can this spool actually
take" answer. Availability never mutates anything:

    available_g = grams_remaining - sum(active reservations)

Location is derived from ``PrinterSlot`` (the single mapping truth); loading a
spool into a printer is a physical move, never a stock movement.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from app.models.filament import Filament
from app.models.filament_reservation import FilamentReservation

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

log = logging.getLogger(__name__)


def active_reserved_g(db: "Session", filament_id: int, *, exclude_reference: str | None = None) -> int:
    """Grams promised to queued/dispatched jobs on this spool."""
    q = db.query(FilamentReservation).filter(
        FilamentReservation.filament_id == filament_id,
        FilamentReservation.status == "active",
    )
    if exclude_reference:
        q = q.filter(FilamentReservation.reference != exclude_reference)
    return sum(r.reserved_g for r in q.all())


def available_grams(db: "Session", filament: Filament, *, exclude_reference: str | None = None) -> int:
    return max(0, filament.grams_remaining - active_reserved_g(db, filament.id, exclude_reference=exclude_reference))


def spool_location(db: "Session", filament_id: int) -> dict | None:
    """The printer slot this spool is loaded into, or None when on a shelf."""
    from app.models.printer import Printer
    from app.models.printer_slot import PrinterSlot

    row = (
        db.query(PrinterSlot, Printer.name)
        .join(Printer, Printer.id == PrinterSlot.printer_id)
        .filter(PrinterSlot.filament_id == filament_id)
        .first()
    )
    if row is None:
        return None
    slot, printer_name = row
    return {"printer_id": slot.printer_id, "printer_name": printer_name, "slot_index": slot.slot_index}


@dataclass
class Candidate:
    filament_id: int
    label: str
    grams_remaining: int
    grams_available: int


def suggest_candidates(
    db: "Session", org_id: int, material: str, required_g: float, *, limit: int = 5,
) -> list[Candidate]:
    """Warehouse spools that could satisfy the requirement, best first.

    Deterministic ranking: opened-but-sufficient spools first (smallest
    remainder — avoids stranding a nearly-full spool), then larger ones.
    """
    rows = (
        db.query(Filament)
        .filter(
            Filament.organization_id == org_id,
            Filament.status == "in_stock",
            Filament.material.ilike(material.strip()),
            Filament.grams_remaining >= required_g,
        )
        .order_by(Filament.grams_remaining.asc(), Filament.id.asc())
        .limit(60)
        .all()
    )
    out: list[Candidate] = []
    for fil in rows:
        available = available_grams(db, fil)
        if available < required_g:
            continue
        label = " ".join(p for p in (fil.brand, fil.material, fil.color) if p) or f"F-{fil.label_id or fil.id}"
        out.append(Candidate(
            filament_id=fil.id, label=label,
            grams_remaining=fil.grams_remaining, grams_available=available,
        ))
        if len(out) >= limit:
            break
    return out


@dataclass
class Reconciliation:
    """Ledger vs physical spools for one spool-tracked product."""

    product_id: int
    product_name: str
    ledger_g: float
    spools_g: int
    loaded_g: int
    reserved_g: int
    empty_spools: int
    total_spools: int

    @property
    def difference_g(self) -> float:
        return self.spools_g - self.ledger_g


def reconciliation(db: "Session", org_id: int) -> list[Reconciliation]:
    """Diagnostic report: warehouse ledger balance vs sum of physical spools.

    Discrepancies are exposed, never silently fixed.
    """
    from app.models.warehouse import Product, StockEntry
    from app.models.printer_slot import PrinterSlot

    products = db.query(Product).filter(
        Product.organization_id == org_id,
        Product.is_active.is_(True),
        Product.id.in_(db.query(Filament.warehouse_product_id).filter(
            Filament.organization_id == org_id,
            Filament.warehouse_product_id.isnot(None),
        )),
    ).all()

    spools = db.query(Filament).filter(
        Filament.organization_id == org_id,
        Filament.warehouse_product_id.isnot(None),
    ).all()
    loaded_ids = {row[0] for row in db.query(PrinterSlot.filament_id).filter(
        PrinterSlot.filament_id.isnot(None),
    ).all()}
    reservations: dict[int, int] = {}
    for r in db.query(FilamentReservation).filter(
        FilamentReservation.organization_id == org_id,
        FilamentReservation.status == "active",
    ).all():
        reservations[r.filament_id] = reservations.get(r.filament_id, 0) + r.reserved_g

    ledger: dict[int, float] = {}
    for row in db.query(StockEntry.product_id, StockEntry.quantity).filter(
        StockEntry.organization_id == org_id,
    ).all():
        ledger[row[0]] = ledger.get(row[0], 0) + float(row[1] or 0)

    out: list[Reconciliation] = []
    for product in products:
        from app.services.filament_accounting import grams_per_unit
        own = [f for f in spools if f.warehouse_product_id == product.id]
        if not own:
            continue
        out.append(Reconciliation(
            product_id=product.id,
            product_name=f"{product.sku} · {product.name}" if product.sku else product.name,
            ledger_g=ledger.get(product.id, 0.0) * float(grams_per_unit(product.unit)),
            spools_g=sum(f.grams_remaining for f in own),
            loaded_g=sum(f.grams_remaining for f in own if f.id in loaded_ids),
            reserved_g=sum(reservations.get(f.id, 0) for f in own),
            empty_spools=sum(1 for f in own if f.status == "empty"),
            total_spools=len(own),
        ))
    return out


# ── Pre-flight material validation ───────────────────────────────────────────

@dataclass
class PreflightRow:
    slot_index: int
    material: str | None
    spool_label: str | None
    filament_id: int | None
    required_g: float          # planned × (1 + safety margin)
    planned_g: float
    remaining_g: int | None
    reserved_g: int
    available_g: int | None
    status: str                # ok | warn | blocked | unmapped
    reason: str | None = None
    suggestions: list[Candidate] = field(default_factory=list)


def preflight_for_print(
    db: "Session",
    org,
    printer,
    planned_by_slot: dict[int, dict],
    *,
    exclude_job_id: int | None = None,
) -> list[PreflightRow]:
    """Per-slot material check for a planned print. Backend-authoritative.

    ``planned_by_slot``: {slot_index: {"grams": float, "material": str|None}}.
    Statuses: ok (fits with margin), warn (fits without margin only),
    blocked (clearly insufficient / empty spool / material mismatch),
    unmapped (no spool in the slot). Blocking is the org's policy choice —
    this function only reports.
    """
    from app.models.printer_slot import PrinterSlot

    margin = max(0, int(getattr(org, "filament_safety_margin_pct", 5) or 0)) / 100.0
    slots = {s.slot_index: s for s in db.query(PrinterSlot).filter(
        PrinterSlot.printer_id == printer.id,
    ).all()}

    rows: list[PreflightRow] = []
    for slot_index, demand in sorted(planned_by_slot.items()):
        planned = max(0.0, float(demand.get("grams") or 0))
        required = planned * (1 + margin)
        wanted_material = (demand.get("material") or "").strip().upper() or None
        slot = slots.get(slot_index)
        filament = db.get(Filament, slot.filament_id) if slot is not None and slot.filament_id else None
        label = f"F-{filament.label_id}" if filament and filament.label_id else None

        if planned <= 0:
            continue
        if filament is None:
            rows.append(PreflightRow(
                slot_index=slot_index, material=wanted_material, spool_label=None,
                filament_id=None, required_g=required, planned_g=planned,
                remaining_g=None, reserved_g=0, available_g=None, status="unmapped",
                reason="Котушку не призначено",
                suggestions=suggest_candidates(db, org.id, wanted_material or "", planned) if wanted_material else [],
            ))
            continue

        remaining = filament.grams_remaining
        reserved = active_reserved_g(db, filament.id, exclude_reference=(f"job:{exclude_job_id}:slot{slot_index}" if exclude_job_id else None))
        available = max(0, remaining - reserved)
        spool_material = (filament.material or "").strip().upper() or None

        if filament.status in ("empty", "retired"):
            rows.append(PreflightRow(
                slot_index=slot_index, material=spool_material, spool_label=label,
                filament_id=filament.id, required_g=required, planned_g=planned,
                remaining_g=remaining, reserved_g=reserved, available_g=available,
                status="blocked", reason="Котушка позначена порожньою",
                suggestions=suggest_candidates(db, org.id, spool_material or wanted_material or "", planned),
            ))
            continue
        if wanted_material and spool_material and wanted_material not in spool_material:
            rows.append(PreflightRow(
                slot_index=slot_index, material=spool_material, spool_label=label,
                filament_id=filament.id, required_g=required, planned_g=planned,
                remaining_g=remaining, reserved_g=reserved, available_g=available,
                status="blocked", reason=f"Матеріал не збігається: потрібно {wanted_material}",
                suggestions=[],
            ))
            continue
        if available >= required:
            rows.append(PreflightRow(
                slot_index=slot_index, material=spool_material, spool_label=label,
                filament_id=filament.id, required_g=required, planned_g=planned,
                remaining_g=remaining, reserved_g=reserved, available_g=available,
                status="ok",
            ))
        elif available >= planned:
            rows.append(PreflightRow(
                slot_index=slot_index, material=spool_material, spool_label=label,
                filament_id=filament.id, required_g=required, planned_g=planned,
                remaining_g=remaining, reserved_g=reserved, available_g=available,
                status="warn", reason="Вистачає лише без запасу на похибку",
                suggestions=suggest_candidates(db, org.id, spool_material or "", planned),
            ))
        else:
            rows.append(PreflightRow(
                slot_index=slot_index, material=spool_material, spool_label=label,
                filament_id=filament.id, required_g=required, planned_g=planned,
                remaining_g=remaining, reserved_g=reserved, available_g=available,
                status="blocked",
                reason=f"Не вистачає {max(0, round(required - available))} г",
                suggestions=suggest_candidates(db, org.id, spool_material or wanted_material or "", planned),
            ))
    return rows


def planned_demand(db: "Session", org_id: int, file, plate: int | None = None) -> dict[int, dict]:
    """Per-slot material demand of one file run: {"grams": g, "material": type}.

    Plate-specific metadata when the request names a plate of a 3MF; otherwise
    the file-level plan (an upper bound for multi-plate files — the safe
    direction for validation and reservations).
    """
    meta = file.filament_meta or {}
    if plate is not None and (file.original_name or "").lower().endswith(".3mf"):
        try:
            from app.services.print_plates import plate_metadata
            meta = plate_metadata(file, org_id, int(plate))
        except Exception:  # noqa: BLE001 — metadata is advisory
            pass
    used_g = meta.get("used_g") or []
    types = meta.get("types") or []
    return {
        index: {"grams": float(g), "material": (types[index] if index < len(types) else None)}
        for index, g in enumerate(used_g) if g and g > 0
    }


def mapped_demand(db, org_id, file, printer, payload):
    """Resolve slicer tools to physical slots once, for preflight and accounting."""
    from app.services.bambu_mapping import build_ams_mapping
    demand = planned_demand(db, org_id, file, payload.get("plate"))
    if not demand:
        return {}
    mapping = {int(k): int(v) for k, v in (payload.get("slot_map") or {}).items()}
    if printer.kind.value == "bambu":
        ams = payload.get("ams_mapping")
        if ams is None and payload.get("use_ams") is not False:
            meta = file.filament_meta or {}
            if payload.get("plate") is not None:
                from app.services.print_plates import plate_metadata
                meta = plate_metadata(file, org_id, payload["plate"])
            ams, _, _ = build_ams_mapping(meta, printer, mapping)
        mapping = {i: (254 if target < 0 else target) for i, target in enumerate(ams or [])}
        if payload.get("use_ams") is False:
            mapping = {i: 254 for i in demand}
    out = {}
    for source, row in demand.items():
        target = mapping.get(source, source)
        if target not in out:
            out[target] = dict(row)
        else:
            out[target]["grams"] += row["grams"]
    return out


def capture_material_plan(db, org_id, printer_id, demand=None):
    from app.models.printer_slot import PrinterSlot
    from app.models.printer import Printer
    slots = db.query(PrinterSlot).join(Printer).filter(
        Printer.organization_id == org_id, Printer.id == printer_id,
    ).all()
    spools = {s.slot_index: s.filament_id for s in slots}
    ids = {fid for fid in spools.values() if fid}
    filaments = {f.id: f for f in db.query(Filament).filter(
        Filament.organization_id == org_id, Filament.id.in_(ids),
    ).order_by(Filament.id).with_for_update().populate_existing().all()}
    indexes = demand.keys() if demand is not None else spools.keys()
    return {str(index): {
        **((demand or {}).get(index) or {}),
        "filament_id": spools.get(index),
        "cost_per_kg": filaments[spools[index]].cost_per_kg if spools.get(index) in filaments else None,
    } for index in indexes}
