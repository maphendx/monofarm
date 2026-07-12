from datetime import date
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class PrinterGroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    color: str | None = None
    nozzle_diameter: float | None = None
    build_x: int | None = None
    build_y: int | None = None
    build_z: int | None = None
    supported_materials: list[str] = []


class PrinterGroupUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    color: str | None = None
    nozzle_diameter: float | None = None
    build_x: int | None = None
    build_y: int | None = None
    build_z: int | None = None
    supported_materials: list[str] | None = None


class PrinterGroupReorderItem(BaseModel):
    id: int
    sort_order: int


class PrinterGroupOut(BaseModel):
    id: int
    name: str
    sort_order: int
    printer_count: int = 0
    color: str | None = None
    nozzle_diameter: float | None = None
    build_x: int | None = None
    build_y: int | None = None
    build_z: int | None = None
    supported_materials: list[str] = []

    model_config = ConfigDict(from_attributes=True)


class PrinterGroupAction(str, Enum):
    mark_out_of_order = "mark_out_of_order"
    restore_service = "restore_service"
    create_maintenance = "create_maintenance"
    enable_autoprint = "enable_autoprint"
    disable_autoprint = "disable_autoprint"
    add_tags = "add_tags"


class PrinterGroupActionRequest(BaseModel):
    action: PrinterGroupAction
    title: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = Field(None, max_length=4000)
    deadline: date | None = None
    plates_loaded: int = Field(1, ge=1, le=10)
    cooldown_temp_c: int = Field(40, ge=20, le=80)
    delay_seconds: int = Field(0, ge=0, le=3600)
    eject_last_plate: bool = True
    tag_ids: list[int] = Field(default_factory=list)


class PrinterGroupActionSkipped(BaseModel):
    printer_id: int
    printer_name: str
    reason: str


class PrinterGroupActionResult(BaseModel):
    action: PrinterGroupAction
    group_id: int
    group_name: str
    affected: int
    skipped: list[PrinterGroupActionSkipped] = Field(default_factory=list)
    task_id: int | None = None
    message: str
