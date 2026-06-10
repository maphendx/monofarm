from datetime import date, datetime, time
from typing import Literal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Time, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base

ScheduleMode = Literal["asap", "not_before", "exact_time", "window"]


class PlanEntry(Base):
    """One scheduled (printer × date × task) row in the daily plan."""

    __tablename__ = "plan_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    plan_date: Mapped[date] = mapped_column(Date, index=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id"))
    task_id: Mapped[int] = mapped_column(ForeignKey("print_tasks.id"))
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    done: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Scheduling fields (all nullable / defaulted — existing rows unaffected)
    start_time: Mapped[time | None] = mapped_column(Time(), nullable=True)
    schedule_mode: Mapped[str] = mapped_column(String(20), default="asap")
    window_start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    window_end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    blocked_reason: Mapped[str | None] = mapped_column(String(100), nullable=True)

    printer = relationship("Printer", foreign_keys=[printer_id])
    task = relationship("PrintTask", foreign_keys=[task_id])
