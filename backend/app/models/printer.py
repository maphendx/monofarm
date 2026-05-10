import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class PrinterKind(str, enum.Enum):
    simplyprint = "simplyprint"
    snapmaker_u1 = "snapmaker_u1"
    other = "other"


class Printer(Base):
    __tablename__ = "printers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[PrinterKind] = mapped_column(Enum(PrinterKind), default=PrinterKind.simplyprint)

    # SimplyPrint linkage (nullable for manual printers like U1)
    sp_printer_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)

    # Manual state (used for U1 / non-API printers)
    manual_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    manual_job: Mapped[str | None] = mapped_column(String(255), nullable=True)
    manual_eta_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    manual_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Moonraker / Mainsail URL (for Snapmaker U1 and other Klipper-based printers)
    moonraker_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
