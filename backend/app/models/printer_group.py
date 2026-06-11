from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class PrinterGroup(Base):
    __tablename__ = "printer_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Profile / capability specs — used to auto-match files to groups
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    nozzle_diameter: Mapped[float | None] = mapped_column(Float, nullable=True)
    build_x: Mapped[int | None] = mapped_column(Integer, nullable=True)
    build_y: Mapped[int | None] = mapped_column(Integer, nullable=True)
    build_z: Mapped[int | None] = mapped_column(Integer, nullable=True)
    supported_materials: Mapped[list[Any]] = mapped_column(JSONB, default=list, server_default="[]")
