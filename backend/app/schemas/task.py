from datetime import date, datetime

from pydantic import BaseModel

from app.models.task import FarmTaskStatus, PrintTaskStatus


class PrintTaskCreate(BaseModel):
    title: str
    quantity: int = 1
    filament_type: str | None = None
    filament_color: str | None = None
    estimated_minutes: int | None = None
    deadline: date | None = None
    notes: str | None = None


class PrintTaskUpdate(BaseModel):
    title: str | None = None
    quantity: int | None = None
    filament_type: str | None = None
    filament_color: str | None = None
    estimated_minutes: int | None = None
    deadline: date | None = None
    notes: str | None = None
    status: PrintTaskStatus | None = None


class PrintTaskOut(BaseModel):
    id: int
    title: str
    quantity: int
    filament_type: str | None
    filament_color: str | None
    estimated_minutes: int | None
    deadline: date | None
    notes: str | None
    status: PrintTaskStatus
    created_at: datetime
    file_name: str | None = None
    file_size: int | None = None
    filament_meta: dict | None = None

    class Config:
        from_attributes = True


class FarmTaskCreate(BaseModel):
    title: str
    description: str | None = None
    deadline: date | None = None
    assignee_id: int | None = None


class FarmTaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    status: FarmTaskStatus | None = None
    deadline: date | None = None
    assignee_id: int | None = None


class FarmTaskOut(BaseModel):
    id: int
    title: str
    description: str | None
    status: FarmTaskStatus
    deadline: date | None
    assignee_id: int | None
    created_at: datetime

    class Config:
        from_attributes = True
