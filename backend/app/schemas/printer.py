from datetime import datetime

from pydantic import BaseModel

from app.models.printer import PrinterKind


class PrinterCreate(BaseModel):
    name: str
    kind: PrinterKind = PrinterKind.snapmaker_u1
    sp_printer_id: str | None = None
    moonraker_url: str | None = None


class PrinterUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    moonraker_url: str | None = None


class PrinterManualUpdate(BaseModel):
    """Operator-set state for non-API printers (U1, etc)."""

    status: str | None = None  # free-form: 'idle', 'printing', 'maintenance', etc.
    job: str | None = None
    eta_minutes: int | None = None


class PrinterOut(BaseModel):
    id: int
    name: str
    kind: PrinterKind
    sp_printer_id: str | None
    moonraker_url: str | None = None
    is_active: bool

    # Live / merged state for the dashboard
    state: str | None = None  # primary state ('printing', 'paused', 'idle', ...)
    flags: list[str] = []  # ['requires_attention', ...] from SimplyPrint
    job: str | None = None  # current job title
    eta_minutes: int | None = None
    updated_at: datetime | None = None
    source: str  # 'simplyprint' | 'moonraker' | 'manual' | 'unknown'

    # Moonraker live extras
    progress_pct: int | None = None
    extruder_temp: float | None = None
    extruder_target: float | None = None
    bed_temp: float | None = None
    bed_target: float | None = None

    # Filament info for the file currently being printed
    current_filament_meta: dict | None = None

    class Config:
        from_attributes = True
