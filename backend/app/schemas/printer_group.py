from pydantic import BaseModel, Field


class PrinterGroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class PrinterGroupUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)


class PrinterGroupReorderItem(BaseModel):
    id: int
    sort_order: int


class PrinterGroupOut(BaseModel):
    id: int
    name: str
    sort_order: int
    printer_count: int = 0

    class Config:
        from_attributes = True
