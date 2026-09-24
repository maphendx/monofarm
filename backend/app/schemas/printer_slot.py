from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.printer_slot import SlotEventType, SlotState


class PrinterSlotOut(BaseModel):
    id: int
    slot_index: int
    filament_id: int | None = None
    material: str | None = None
    color: str | None = None
    hex_color: str | None = None
    brand: str | None = None
    grams_at_load: int | None = None
    state: SlotState
    unit_index: int | None = None
    is_external: bool = False
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SlotAssign(BaseModel):
    sync_printer: bool = True
    filament_id: int | None = None  # None = unload


class SlotEventOut(BaseModel):
    id: int
    slot_index: int
    event: SlotEventType
    filament_id: int | None = None
    grams_delta: int | None = None
    task_id: int | None = None
    user_id: int | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
