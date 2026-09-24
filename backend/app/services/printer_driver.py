"""Kind-aware printer driver abstraction.

All new business logic (costing, slot sync, history) calls get_driver(kind)
instead of branching on PrinterKind directly. Concrete drivers delegate to
the existing moonraker.py / bambu.py — they do not duplicate parsing logic.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from sqlalchemy.orm import Session
    from app.models.printer import Printer
    from app.models.printer_slot import PrinterSlot

from app.models.printer import PrinterKind

log = logging.getLogger(__name__)


@runtime_checkable
class PrinterDriver(Protocol):
    kind: PrinterKind

    def get_live_status(self, printer: "Printer") -> dict:
        """Return normalized live-state dict (same shape as moonraker._parse)."""
        ...

    def sync_slots(self, db: "Session", printer: "Printer") -> list["PrinterSlot"]:
        """Upsert printer_slots rows from the printer's source of truth.

        Returns the updated list of PrinterSlot rows (not flushed/committed —
        caller owns the transaction).
        """
        ...




# ── Moonraker (Klipper-based: U1, other) ─────────────────────────────────────

class MoonrakerDriver:
    kind = PrinterKind.snapmaker_u1  # representative; used for any moonraker_url printer

    def get_live_status(self, printer: "Printer") -> dict:
        from app.services import moonraker
        if not printer.moonraker_url:
            return {"state": "unknown"}
        return moonraker.get_live_status(printer.moonraker_url, org_id=printer.organization_id)

    def sync_slots(self, db: "Session", printer: "Printer") -> list["PrinterSlot"]:
        """Read printer.loaded_filaments JSONB → upsert printer_slots.

        Operators assign physical spools via the UI slot endpoints; this method
        propagates existing loaded_filaments data into the normalised table on
        first sync or after a JSONB-only update.
        """
        from datetime import datetime, timezone
        from app.models.printer_slot import PrinterSlot, SlotState

        slots: list[PrinterSlot] = []
        loaded = printer.loaded_filaments or []
        for item in loaded:
            idx = int(item.get("slot", 0))
            row = db.query(PrinterSlot).filter_by(
                printer_id=printer.id, slot_index=idx
            ).first()
            if row is None:
                row = PrinterSlot(printer_id=printer.id, slot_index=idx)
                db.add(row)

            empty = item.get("empty", False) or not item.get("color")
            row.state = SlotState.empty if empty else SlotState.loaded
            row.material = item.get("type") or None
            row.color = item.get("color") or None
            hex_c = item.get("color", "")
            row.hex_color = hex_c[:7] if hex_c.startswith("#") and len(hex_c) >= 4 else None
            row.brand = item.get("brand") or None
            row.filament_id = item.get("filament_id") or None
            row.unit_index = 0
            row.is_external = False
            row.updated_at = datetime.now(timezone.utc)
            slots.append(row)

        db.flush()
        return slots


# ── Bambu Lab ─────────────────────────────────────────────────────────────────

class BambuDriver:
    kind = PrinterKind.bambu

    def get_live_status(self, printer: "Printer") -> dict:
        from app.services import bambu
        if not printer.bambu_dev_id:
            return {"state": "unknown"}
        return bambu.get_cached_state(printer.bambu_dev_id, org_id=printer.organization_id)

    def sync_slots(self, db: "Session", printer: "Printer") -> list["PrinterSlot"]:
        """Pull AMS trays from Bambu cache → upsert printer_slots.

        Delegates to the existing bambu.get_ams_filaments() — does NOT duplicate
        _parse_ams logic. External spool (slot 254) is is_external=True.
        """
        from datetime import datetime, timezone
        from app.services import bambu
        from app.models.printer_slot import PrinterSlot, SlotState

        if not printer.bambu_dev_id:
            return []

        trays = bambu.get_ams_filaments(printer.bambu_dev_id, org_id=printer.organization_id) or []
        slots: list[PrinterSlot] = []
        for tray in trays:
            idx = int(tray.get("slot", 0))
            row = db.query(PrinterSlot).filter_by(
                printer_id=printer.id, slot_index=idx
            ).first()
            if row is None:
                row = PrinterSlot(printer_id=printer.id, slot_index=idx)
                db.add(row)

            empty = tray.get("empty", True)
            row.state = SlotState.empty if empty else SlotState.loaded
            row.material = tray.get("type") or None
            raw_hex = tray.get("color", "")
            row.color = raw_hex if not empty else None
            row.hex_color = raw_hex[:7] if raw_hex.startswith("#") else None
            row.brand = tray.get("brand") or None
            row.filament_id = tray.get("filament_id") or None
            unit_id = tray.get("unit_id")
            row.unit_index = int(unit_id) if unit_id is not None else None
            row.is_external = idx == 254
            row.updated_at = datetime.now(timezone.utc)
            slots.append(row)

        db.flush()
        return slots


# ── Fallback / resolver ───────────────────────────────────────────────────────

class _ManualDriver:
    kind = PrinterKind.other

    def get_live_status(self, printer: "Printer") -> dict:
        return {"state": printer.manual_status or "unknown"}

    def sync_slots(self, db: "Session", printer: "Printer") -> list:
        return []


_DRIVERS: dict[PrinterKind, PrinterDriver] = {
    PrinterKind.snapmaker_u1: MoonrakerDriver(),
    PrinterKind.bambu: BambuDriver(),
    PrinterKind.other: _ManualDriver(),
}


def get_driver(kind: PrinterKind) -> PrinterDriver:
    return _DRIVERS.get(kind, _DRIVERS[PrinterKind.other])



