from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Filament(Base):
    __tablename__ = "filaments"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sku: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    material: Mapped[str] = mapped_column(String(40))
    color: Mapped[str] = mapped_column(String(40))
    hex_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    brand: Mapped[str | None] = mapped_column(String(80), nullable=True)
    warehouse_product_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("wh_products.id", ondelete="SET NULL"), nullable=True
    )
    grams_remaining: Mapped[int] = mapped_column(Integer, default=0)
    min_grams: Mapped[int] = mapped_column(Integer, default=0)
    cost_per_kg: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class FilamentLog(Base):
    """Ledger of every gram change on a spool."""
    __tablename__ = "filament_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    filament_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    delta_grams: Mapped[int] = mapped_column(Integer, nullable=False)
    grams_after: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    task_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("print_tasks.id", ondelete="SET NULL"), nullable=True
    )
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
