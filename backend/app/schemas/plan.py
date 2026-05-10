from datetime import date, datetime

from pydantic import BaseModel

from app.schemas.task import PrintTaskOut


class PlanEntryCreate(BaseModel):
    plan_date: date
    printer_id: int
    task_id: int
    note: str | None = None


class PlanEntryUpdate(BaseModel):
    done: bool | None = None
    note: str | None = None


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

    class Config:
        from_attributes = True
