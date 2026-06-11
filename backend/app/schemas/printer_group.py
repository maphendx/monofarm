from pydantic import BaseModel, Field


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

    class Config:
        from_attributes = True
