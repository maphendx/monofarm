from datetime import datetime

from pydantic import BaseModel, Field

from app.models.printer import PrinterKind


class FilamentSlot(BaseModel):
    """One filament slot in a printer (colour swatch + material label)."""
    slot: int
    color: str = "#888888"       # CSS hex colour
    color_name: str | None = None  # human label from the colour palette
    type: str = "PLA"            # material string, e.g. "PLA", "PETG", "ABS"
    brand: str | None = None
    filament_id: int | None = None  # optional link to Filament inventory row


class PrinterCreate(BaseModel):
    name: str
    kind: PrinterKind = PrinterKind.snapmaker_u1
    sp_printer_id: str | None = None
    moonraker_url: str | None = None
    bambu_dev_id: str | None = None
    bambu_access_code: str | None = None


class PrinterUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    moonraker_url: str | None = None
    bambu_dev_id: str | None = None
    bambu_access_code: str | None = None


class PrinterManualUpdate(BaseModel):
    """Operator-set state for non-API printers (U1, etc)."""

    status: str | None = None  # free-form: 'idle', 'printing', 'maintenance', etc.
    job: str | None = None
    eta_minutes: int | None = None


class PrinterReorderItem(BaseModel):
    id: int
    sort_order: int


class PrinterGroupAssign(BaseModel):
    group_id: int | None  # None = remove from group


class PrinterOut(BaseModel):
    id: int
    name: str
    kind: PrinterKind
    sp_printer_id: str | None
    moonraker_url: str | None = None
    bambu_dev_id: str | None = None
    bambu_model: str | None = None
    is_active: bool
    sort_order: int = 0
    group_id: int | None = None
    group_name: str | None = None
    loaded_filaments: list[FilamentSlot] = Field(default_factory=list)

    # Live / merged state for the dashboard
    state: str | None = None  # primary state ('printing', 'paused', 'idle', ...)
    flags: list[str] = []  # ['requires_attention', ...] from SimplyPrint
    job: str | None = None  # current job title
    eta_minutes: int | None = None
    updated_at: datetime | None = None
    source: str  # 'simplyprint' | 'moonraker' | 'bambu' | 'manual' | 'unknown'

    # Live telemetry extras (Moonraker + Bambu)
    progress_pct: int | None = None
    extruder_temp: float | None = None
    extruder_target: float | None = None
    bed_temp: float | None = None
    bed_target: float | None = None

    # Filament info for the file currently being printed
    current_filament_meta: dict | None = None

    class Config:
        from_attributes = True
