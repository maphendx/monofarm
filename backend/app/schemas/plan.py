from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel

from app.schemas.task import PrintTaskOut

ScheduleMode = Literal["asap", "not_before", "exact_time", "window"]


class PlanEntryCreate(BaseModel):
    plan_date: date
    printer_id: int
    task_id: int
    note: str | None = None
    # Scheduling (optional — omit for asap behaviour)
    start_time: time | None = None
    schedule_mode: ScheduleMode = "asap"
    window_start_at: datetime | None = None
    window_end_at: datetime | None = None
    priority: int = 0


class PlanEntryUpdate(BaseModel):
    done: bool | None = None
    note: str | None = None
    # Scheduling
    start_time: time | None = None
    schedule_mode: ScheduleMode | None = None
    window_start_at: datetime | None = None
    window_end_at: datetime | None = None
    priority: int | None = None
    blocked_reason: str | None = None


class PlanEntryOut(BaseModel):
    id: int
    plan_date: date
    printer_id: int
    printer_name: str
    task_id: int
    task: PrintTaskOut
    sequence: int
    note: str | None
    done: bool
    created_at: datetime
    # Scheduling
    start_time: time | None = None
    schedule_mode: str = "asap"
    window_start_at: datetime | None = None
    window_end_at: datetime | None = None
    priority: int = 0
    blocked_reason: str | None = None
    # Computed by router
    conflict: bool = False
    end_time: time | None = None

    class Config:
        from_attributes = True


class CalendarEntryOut(PlanEntryOut):
    """PlanEntryOut enriched with conflict/end_time for calendar rendering."""

    pass


class CalendarDayOut(BaseModel):
    """All scheduled entries for a single printer on a single date."""

    printer_id: int
    printer_name: str
    plan_date: date
    entries: list[CalendarEntryOut]


class CalendarLaneOut(BaseModel):
    """All entries for one printer across the requested date range."""

    printer_id: int
    printer_name: str
    printer_kind: str  # "bambu" | "snapmaker_u1" | "other" — for UI dispatch hints
    days: list[CalendarDayOut]
