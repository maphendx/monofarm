from datetime import datetime

from pydantic import BaseModel

from app.models.printer import PrinterKind


class PrinterCreate(BaseModel):
    name: str
    kind: PrinterKind = PrinterKind.snapmaker_u1
    sp_printer_id: str | None = None


class PrinterUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None


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
    is_active: bool

    # Live / merged state for the dashboard
    state: str | None = None  # primary state ('printing', 'paused', 'idle', ...)
    flags: list[str] = []  # ['requires_attention', ...] from SimplyPrint
    job: str | None = None  # current job title (for U1 — manual_job)
    eta_minutes: int | None = None
    updated_at: datetime | None = None
    source: str  # 'simplyprint' | 'manual' | 'unknown'

    class Config:
        from_attributes = True
