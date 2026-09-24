from datetime import date, datetime

from pydantic import BaseModel, ConfigDict

from app.models.task import FarmTaskStatus, PrintTaskStatus
from app.schemas.tag import TagOut


class PrintTaskCreate(BaseModel):
    title: str
    quantity: int = 1
    filament_type: str | None = None
    filament_color: str | None = None
    estimated_minutes: int | None = None
    deadline: date | None = None
    notes: str | None = None
    product_id: int | None = None
    assigned_group_id: int | None = None
    target_printer_ids: list[int] | None = None


class FilamentConsumption(BaseModel):
    filament_id: int
    grams: int


class PrintTaskUpdate(BaseModel):
    title: str | None = None
    quantity: int | None = None
    filament_type: str | None = None
    filament_color: str | None = None
    estimated_minutes: int | None = None
    deadline: date | None = None
    notes: str | None = None
    status: PrintTaskStatus | None = None
    product_id: int | None = None
    assigned_group_id: int | None = None
    target_printer_ids: list[int] | None = None
    filament_consumptions: list[FilamentConsumption] | None = None
    # production outcome (supplied together with status=done)
    pieces_ok: int | None = None
    pieces_defective: int | None = None
    defect_reason: str | None = None


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
    filament_consumptions: list | None = None
    product_id: int | None = None
    product_name: str | None = None
    assigned_group_id: int | None = None
    assigned_group_name: str | None = None
    target_printer_ids: list[int] | None = None
    pieces_ok: int | None = None
    pieces_defective: int | None = None
    defect_reason: str | None = None
    output_accounted_from_runs: bool = False
    material_cost_uah: float | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    # Queue page fields (computed in list_tasks)
    gcode_file_id: int | None = None
    has_thumbnail: bool = False
    created_by_name: str | None = None
    printed_count: int = 0
    assigned_printer_id: int | None = None
    assigned_printer_name: str | None = None
    tags: list[TagOut] = []

    model_config = ConfigDict(from_attributes=True)


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

    model_config = ConfigDict(from_attributes=True)
