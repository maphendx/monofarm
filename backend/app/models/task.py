import enum
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Date, DateTime, Enum, Float, ForeignKey, Integer, String, Text, func

from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base

if TYPE_CHECKING:
    from app.models.tag import Tag


class PrintTaskStatus(str, enum.Enum):
    queued = "queued"
    in_progress = "in_progress"
    done = "done"
    cancelled = "cancelled"


class PrintTask(Base):
    """A part / batch that needs to be printed."""

    __tablename__ = "print_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    filament_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    filament_color: Mapped[str | None] = mapped_column(String(40), nullable=True)
    estimated_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    file_ref: Mapped[str | None] = mapped_column(String(500), nullable=True)
    file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gcode_file_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("gcode_files.id", ondelete="SET NULL"), nullable=True, index=True
    )
    filament_meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # [{filament_id: int, grams: int}] — set at send time, consumed on done
    filament_consumptions: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[PrintTaskStatus] = mapped_column(Enum(PrintTaskStatus), default=PrintTaskStatus.queued)

    # production outcome
    pieces_ok: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pieces_defective: Mapped[int | None] = mapped_column(Integer, nullable=True)
    defect_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    material_cost_uah: Mapped[float | None] = mapped_column(Float, nullable=True)

    # optional link to a warehouse product (enables auto PRODUCTION_IN on done)
    product_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("wh_products.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Tags
    tags: Mapped[list["Tag"]] = relationship(
        "Tag",
        secondary="print_task_tags",
        back_populates="print_tasks",
        lazy="selectin",
    )


class FarmTaskStatus(str, enum.Enum):
    todo = "todo"
    in_progress = "in_progress"
    done = "done"


class FarmTask(Base):
    """General farm tasks (maintenance, supply, etc) — task manager."""

    __tablename__ = "farm_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[FarmTaskStatus] = mapped_column(Enum(FarmTaskStatus), default=FarmTaskStatus.todo)
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
