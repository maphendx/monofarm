import enum
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column


from app.core.db import Base


class PrinterKind(str, enum.Enum):
    snapmaker_u1 = "snapmaker_u1"
    bambu = "bambu"
    other = "other"


class Printer(Base):
    __tablename__ = "printers"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[PrinterKind] = mapped_column(Enum(PrinterKind), default=PrinterKind.other)

    # Manual state (used for U1 / non-API printers)
    manual_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    manual_job: Mapped[str | None] = mapped_column(String(255), nullable=True)
    manual_eta_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    manual_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Moonraker / Mainsail URL (for Snapmaker U1 and other Klipper-based printers)
    moonraker_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Bambu Lab Cloud linkage
    bambu_dev_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    bambu_access_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    bambu_dev_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    bambu_model: Mapped[str | None] = mapped_column(String(32), nullable=True)

    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    # Array of {slot, color, type, brand?, filament_id?} dicts — what's loaded in each slot
    loaded_filaments: Mapped[list[Any]] = mapped_column(JSONB, default=list, server_default="[]")
    group_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("printer_groups.id", ondelete="SET NULL"), nullable=True, index=True
    )

    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
