"""Operator-reported quantities for one physical print, independent of queue tasks."""
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class PrintOutputItem(BaseModel):
    product_id: int | None = Field(default=None, gt=0)
    pieces_ok: int = Field(ge=0, le=1_000_000, strict=True)
    pieces_defective: int = Field(default=0, ge=0, le=1_000_000, strict=True)


class PrintOutputCreate(BaseModel):
    items: list[PrintOutputItem] = Field(min_length=1, max_length=100)
    warehouse_id: int | None = Field(default=None, gt=0)
    defect_reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_receipt(self):
        ids = [item.product_id for item in self.items if item.product_id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("Each product must have a single combined result row")
        if self.warehouse_id and any(item.product_id is None and item.pieces_ok for item in self.items):
            raise ValueError("Select a product for every item received into stock")
        return self


class PrintOutputItemOut(PrintOutputItem):
    product_name: str | None = None


class PrintOutputOut(BaseModel):
    items: list[PrintOutputItemOut]
    warehouse_id: int | None = None
    defect_reason: str | None = None
    recorded_at: datetime
    recorded_by_id: int
    accounting_state: str | None = None

    @model_validator(mode="before")
    @classmethod
    def legacy_accounting_state(cls, value):
        if isinstance(value, dict) and not value.get("accounting_state"):
            from app.services.print_output import pending_output
            if pending_output(value):
                return {**value, "accounting_state": "pending"}
        return value


class ClearBedPayload(BaseModel):
    request_id: UUID | None = None
    history_id: int | None = Field(default=None, gt=0)
    file_name: str | None = Field(default=None, max_length=512)
    output: PrintOutputCreate | None = None

    @model_validator(mode="after")
    def require_request_id(self):
        if self.output is not None and self.request_id is None:
            raise ValueError("request_id is required when reporting output")
        return self


class PrintOutputPlanItem(BaseModel):
    product_id: int
    product_name: str | None = None
    planned_qty: int


class PrintOutputPlanOut(BaseModel):
    """Frozen production plan of one dispatched run (from BambuCloudJob.output_plan)."""
    file_id: int | None = None
    plate: int | None = None
    warehouse_id: int | None = None
    print_task_id: int | None = None
    production_batch_id: int | None = None
    items: list[PrintOutputPlanItem] = []


class PrintOutputContext(BaseModel):
    history_id: int | None
    file_name: str | None
    output: PrintOutputOut | None = None
    plan: PrintOutputPlanOut | None = None
    # Actual material usage of the run, when the tracker/costing knows it.
    filament_g: float | None = None
    material_cost: float | None = None


class HistoryOutputPayload(BaseModel):
    """Late accounting for a finished run from the history page."""
    request_id: UUID
    output: PrintOutputCreate
