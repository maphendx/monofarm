import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class SlotState(str, enum.Enum):
    empty = "empty"
    loaded = "loaded"
    loading = "loading"
    unloading = "unloading"
    error = "error"
    runout = "runout"


class SlotEventType(str, enum.Enum):
    load = "load"
    unload = "unload"
    swap = "swap"
    runout = "runout"
    manual_edit = "manual_edit"


class PrinterSlot(Base):
    """One physical filament slot on a printer (source of truth for U1 toolheads).

    slot_index is 0-based to match G-code T0..T3 and loaded_filaments JSONB.
    Snapshot fields (material/color/hex_color/brand) are copied from the linked
    Filament row at load time so they render without a join.
    """
    __tablename__ = "printer_slots"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_index: Mapped[int] = mapped_column(Integer, nullable=False)

    filament_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("filaments.id", ondelete="SET NULL"), nullable=True
    )

    # Denormalized snapshot — filled from Filament at load time
    material: Mapped[str | None] = mapped_column(String(40), nullable=True)
    color: Mapped[str | None] = mapped_column(String(40), nullable=True)
    hex_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    brand: Mapped[str | None] = mapped_column(String(80), nullable=True)

    grams_at_load: Mapped[int | None] = mapped_column(Integer, nullable=True)
    state: Mapped[SlotState] = mapped_column(
        Enum(SlotState), default=SlotState.empty, server_default="empty"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (UniqueConstraint("printer_id", "slot_index", name="uq_printer_slot"),)


class SlotEvent(Base):
    """Ledger of every slot-state change on a printer."""
    __tablename__ = "slot_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_index: Mapped[int] = mapped_column(Integer, nullable=False)
    event: Mapped[SlotEventType] = mapped_column(Enum(SlotEventType), nullable=False)
    filament_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("filaments.id", ondelete="SET NULL"), nullable=True
    )
    grams_delta: Mapped[int | None] = mapped_column(Integer, nullable=True)
    task_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("print_tasks.id", ondelete="SET NULL"), nullable=True
    )
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    meta: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
