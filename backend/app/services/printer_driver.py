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

    def get_slot_consumption(
        self,
        printer: "Printer",
        filename: str | None,
        filament_g_total: float | None,
        db: "Session | None" = None,
    ) -> dict[int, float]:
        """Return {slot_index: grams_used} for a completed print.

        Falls back to distributing filament_g_total equally across loaded slots
        when per-slot data is unavailable.
        """
        ...


# ── Moonraker (Klipper-based: U1, other) ─────────────────────────────────────

class MoonrakerDriver:
    kind = PrinterKind.snapmaker_u1  # representative; used for any moonraker_url printer

    def get_live_status(self, printer: "Printer") -> dict:
        from app.services import moonraker
        if not printer.moonraker_url:
            return {"state": "unknown"}
        return moonraker.get_live_status(printer.moonraker_url)

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

    def get_slot_consumption(
        self,
        printer: "Printer",
        filename: str | None,
        filament_g_total: float | None,
        db: "Session | None" = None,
    ) -> dict[int, float]:
        from app.services import moonraker

        if printer.moonraker_url and filename:
            try:
                meta = moonraker.get_remote_file_meta(printer.moonraker_url, filename)
                used_g: list[float] = meta.get("used_g") or []
                if used_g:
                    return {i: g for i, g in enumerate(used_g) if g and g > 0}
            except Exception as e:
                log.debug("MoonrakerDriver.get_slot_consumption: meta fetch failed: %s", e)

        return _fallback_consumption(db, printer, filament_g_total)


# ── Bambu Lab ─────────────────────────────────────────────────────────────────

class BambuDriver:
    kind = PrinterKind.bambu

    def get_live_status(self, printer: "Printer") -> dict:
        from app.services import bambu
        if not printer.bambu_dev_id:
            return {"state": "unknown"}
        return bambu.get_cached_state(printer.bambu_dev_id)

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

        trays = bambu.get_ams_filaments(printer.bambu_dev_id) or []
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

    def get_slot_consumption(
        self,
        printer: "Printer",
        filename: str | None,
        filament_g_total: float | None,
        db: "Session | None" = None,
    ) -> dict[int, float]:
        """For Bambu: use filament_g from MQTT state as single-slot total for now.

        Bambu does not expose per-AMS-slot grams used via the available APIs.
        When filament_g_total is known, attribute it to the active_tray slot;
        fall back to equal distribution across all loaded slots.
        """
        if printer.bambu_dev_id and filament_g_total and filament_g_total > 0:
            from app.services import bambu
            state = bambu.get_cached_state(printer.bambu_dev_id)
            active = state.get("active_tray")
            if active is not None and active != 254:
                return {int(active): filament_g_total}

        return _fallback_consumption(db, printer, filament_g_total)


# ── Fallback / resolver ───────────────────────────────────────────────────────

class _ManualDriver:
    kind = PrinterKind.other

    def get_live_status(self, printer: "Printer") -> dict:
        return {"state": printer.manual_status or "unknown"}

    def sync_slots(self, db: "Session", printer: "Printer") -> list:
        return []

    def get_slot_consumption(self, printer, filename, filament_g_total, db=None) -> dict:
        return _fallback_consumption(db, printer, filament_g_total)


_DRIVERS: dict[PrinterKind, PrinterDriver] = {
    PrinterKind.snapmaker_u1: MoonrakerDriver(),
    PrinterKind.bambu: BambuDriver(),
    PrinterKind.other: _ManualDriver(),
}


def get_driver(kind: PrinterKind) -> PrinterDriver:
    return _DRIVERS.get(kind, _DRIVERS[PrinterKind.other])


def _fallback_consumption(
    db: "Session | None", printer: "Printer", total_g: float | None
) -> dict[int, float]:
    """Distribute total_g equally across all loaded slots."""
    if not total_g or total_g <= 0 or db is None:
        return {}
    from app.models.printer_slot import PrinterSlot
    loaded = db.query(PrinterSlot).filter(
        PrinterSlot.printer_id == printer.id,
        PrinterSlot.filament_id.isnot(None),
    ).all()
    if not loaded:
        return {}
    per_slot = total_g / len(loaded)
    return {s.slot_index: per_slot for s in loaded}
