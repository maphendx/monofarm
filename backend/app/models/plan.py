from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


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
