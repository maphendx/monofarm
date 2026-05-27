from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel

from app.models.warehouse import (
    BatchStatus, CashTxCategory, CashTxType, CounterpartyType,
    MovementType, OrderSource, OrderStatus, SpecOpType, WarehouseType,
)


# ── Product category ──────────────────────────────────────────────────────────

class ProductCategoryCreate(BaseModel):
    name:       str
    color:      str | None = None
    sort_order: int = 0


class ProductCategoryUpdate(BaseModel):
    name:       str | None = None
    color:      str | None = None
    sort_order: int | None = None


class ProductCategoryOut(BaseModel):
    id:         int
    name:       str
    color:      str | None
    sort_order: int
    created_at: datetime

    class Config:
        from_attributes = True


# ── Warehouse ─────────────────────────────────────────────────────────────────

class WarehouseCreate(BaseModel):
    name:     str
    type:     WarehouseType
    location: str | None = None


class WarehouseUpdate(BaseModel):
    name:      str | None = None
    type:      WarehouseType | None = None
    location:  str | None = None
    is_active: bool | None = None


class WarehouseOut(BaseModel):
    id:         int
    name:       str
    type:       WarehouseType
    location:   str | None
    is_active:  bool
    created_at: datetime

    class Config:
        from_attributes = True


# ── Counterparty ──────────────────────────────────────────────────────────────

class CounterpartyCreate(BaseModel):
    type:       CounterpartyType
    name:       str
    email:      str | None = None
    phone:      str | None = None
    tax_number: str | None = None
    address:    str | None = None
    notes:      str | None = None


class CounterpartyUpdate(BaseModel):
    type:       CounterpartyType | None = None
    name:       str | None = None
    email:      str | None = None
    phone:      str | None = None
    tax_number: str | None = None
    address:    str | None = None
    notes:      str | None = None


class CounterpartyOut(BaseModel):
    id:          int
    type:        CounterpartyType
    name:        str
    email:       str | None
    phone:       str | None
    tax_number:  str | None
    address:     str | None
    notes:       str | None
    balance:     Decimal
    external_id: str | None
    created_at:  datetime

    class Config:
        from_attributes = True


class CounterpartyBalanceAdjust(BaseModel):
    delta: Decimal   # positive = they paid us, negative = we paid them
    note:  str | None = None


# ── Product ───────────────────────────────────────────────────────────────────

class ProductCreate(BaseModel):
    name:          str
    sku:           str
    barcode:       str | None = None
    categories:    list[str] = []
    unit:          str = "шт"
    description:   str | None = None
    sale_price:    Decimal | None = None
    min_stock:     int | None = None
    desired_stock: int | None = None
    box_limit:     int | None = None


class ProductUpdate(BaseModel):
    name:          str | None = None
    sku:           str | None = None
    barcode:       str | None = None
    categories:    list[str] | None = None
    unit:          str | None = None
    description:   str | None = None
    sale_price:    Decimal | None = None
    is_active:     bool | None = None
    min_stock:     int | None = None
    desired_stock: int | None = None
    box_limit:     int | None = None


class ProductOut(BaseModel):
    id:            int
    name:          str
    sku:           str
    barcode:       str | None
    categories:    list[str]
    unit:          str
    description:   str | None
    is_active:     bool
    sale_price:    Decimal | None
    cost_price:    Decimal | None
    direct_cost:   Decimal | None
    full_cost:     Decimal | None
    min_stock:     int | None
    desired_stock: int | None
    box_limit:     int | None
    created_at:    datetime

    class Config:
        from_attributes = True


# ── Specification ─────────────────────────────────────────────────────────────

class SpecComponentCreate(BaseModel):
    name:        str
    material_id: int | None = None
    quantity:    Decimal
    unit:        str = "g"
    unit_price:  Decimal | None = None
    waste_pct:   Decimal = Decimal("0")
    sort_order:  int = 0


class SpecComponentOut(BaseModel):
    id:          int
    name:        str
    material_id: int | None
    quantity:    Decimal
    unit:        str
    unit_price:  Decimal | None
    waste_pct:   Decimal
    sort_order:  int

    class Config:
        from_attributes = True


class SpecOperationCreate(BaseModel):
    type:                SpecOpType
    name:                str
    sort_order:          int = 0
    print_time_min:      Decimal | None = None
    power_watts:         int | None = None
    labor_minutes:       Decimal | None = None
    labor_rate_per_hour: Decimal | None = None
    explicit_cost:       Decimal | None = None
    notes:               str | None = None


class SpecOperationOut(BaseModel):
    id:                  int
    type:                SpecOpType
    name:                str
    sort_order:          int
    print_time_min:      Decimal | None
    power_watts:         int | None
    labor_minutes:       Decimal | None
    labor_rate_per_hour: Decimal | None
    explicit_cost:       Decimal | None
    notes:               str | None

    class Config:
        from_attributes = True


class SpecCreate(BaseModel):
    product_id: int | None = None
    name:       str = "Основна"
    notes:      str | None = None


class SpecOut(BaseModel):
    id:         int
    product_id: int
    version:    int
    name:       str
    is_default: bool
    notes:      str | None
    components: list[SpecComponentOut] = []
    operations: list[SpecOperationOut] = []
    created_at: datetime

    class Config:
        from_attributes = True


# ── Cost breakdown ────────────────────────────────────────────────────────────

class CostBreakdown(BaseModel):
    material_cost:     Decimal
    electricity_cost:  Decimal
    labor_cost:        Decimal
    other_cost:        Decimal
    total:             Decimal
    print_time_min:    Decimal
    margin_pct:        Decimal | None


# ── Stock ─────────────────────────────────────────────────────────────────────

class CellLocationOut(BaseModel):
    name: str
    quantity: Decimal

class StockEntryOut(BaseModel):
    id:             int
    product_id:     int
    product_name:   str
    product_sku:    str
    product_barcode: str | None
    product_categories: list[str] = []
    product_unit:   str
    warehouse_id:   int
    warehouse_name: str
    locations:      list[CellLocationOut] = []
    quantity:       Decimal
    reserved_qty:   Decimal
    available:      Decimal
    total_stock:    Decimal
    full_cost:      Decimal | None
    min_stock:      int | None
    desired_stock:  int | None
    box_limit:      int | None
    boxes_to_order: int | None   # ceil((desired - available) / box_limit) when available < desired
    updated_at:     datetime

    class Config:
        from_attributes = True


# ── Movement ──────────────────────────────────────────────────────────────────

class MovementCreate(BaseModel):
    type:              MovementType
    product_id:        int
    warehouse_from_id: int | None = None
    warehouse_to_id:   int | None = None
    quantity:          Decimal
    unit:              str = "шт"
    unit_cost:         Decimal | None = None
    reason:            str | None = None
    batch_id:          int | None = None
    order_id:          int | None = None


class MovementOut(BaseModel):
    id:                int
    type:              MovementType
    product_id:        int
    product_name:      str
    warehouse_from_id: int | None
    warehouse_to_id:   int | None
    quantity:          Decimal
    unit:              str
    unit_cost:         Decimal | None
    total_cost:        Decimal | None
    reason:            str | None
    batch_id:          int | None
    order_id:          int | None
    created_at:        datetime

    class Config:
        from_attributes = True


# ── ProductionBatch ───────────────────────────────────────────────────────────

class BatchCreate(BaseModel):
    product_id:       int
    specification_id: int | None = None
    target_qty:       int
    due_date:         date | None = None
    notes:            str | None = None
    order_id:         int | None = None


class BatchUpdate(BaseModel):
    target_qty:  int | None = None
    status:      BatchStatus | None = None
    due_date:    date | None = None
    notes:       str | None = None


class BatchClose(BaseModel):
    good_qty:   int
    defect_qty: int = 0
    finished_warehouse_id: int | None = None
    defect_warehouse_id:   int | None = None


class BatchOut(BaseModel):
    id:               int
    product_id:       int
    product_name:     str
    specification_id: int | None
    target_qty:       int
    printed_qty:      int
    good_qty:         int
    defect_qty:       int
    status:           BatchStatus
    due_date:         date | None
    order_id:         int | None
    notes:            str | None
    created_at:       datetime
    updated_at:       datetime

    class Config:
        from_attributes = True


# ── Order ─────────────────────────────────────────────────────────────────────

class OrderItemCreate(BaseModel):
    product_id:   int
    quantity:     int
    unit_price:   Decimal
    warehouse_id: int | None = None  # source warehouse (optional; auto-picked on reserve)


class OrderCreate(BaseModel):
    counterparty_id: int | None = None
    customer_name:   str | None = None   # used if no counterparty_id
    source:          OrderSource = OrderSource.manual
    due_date:        date | None = None
    currency:        str = "UAH"
    notes:           str | None = None
    items:           list[OrderItemCreate] = []


class OrderUpdate(BaseModel):
    counterparty_id: int | None = None
    customer_name:   str | None = None
    status:          OrderStatus | None = None
    due_date:        date | None = None
    notes:           str | None = None
    paid_amount:     Decimal | None = None


class OrderItemOut(BaseModel):
    id:           int
    product_id:   int
    product_name: str
    warehouse_id: int | None
    quantity:     int
    unit_price:   Decimal
    total_price:  Decimal

    class Config:
        from_attributes = True


class OrderOut(BaseModel):
    id:               int
    order_number:     str
    counterparty_id:  int | None
    counterparty_name: str | None   # denormalised for UI convenience
    customer_name:    str | None
    source:           OrderSource
    status:           OrderStatus
    total_amount:     Decimal | None
    paid_amount:      Decimal
    outstanding:      Decimal        # total_amount - paid_amount
    currency:         str
    due_date:         date | None
    notes:            str | None
    items:            list[OrderItemOut] = []
    created_at:       datetime

    class Config:
        from_attributes = True


class ReserveRequest(BaseModel):
    warehouse_id: int   # warehouse to reserve stock from


# ── Cash Flow ─────────────────────────────────────────────────────────────────

class CashTxCreate(BaseModel):
    type:             CashTxType
    category:         CashTxCategory
    amount:           Decimal           # always positive
    counterparty_id:  int | None = None
    order_id:         int | None = None
    description:      str | None = None
    transaction_date: date


class CashTxOut(BaseModel):
    id:               int
    type:             CashTxType
    category:         CashTxCategory
    amount:           Decimal
    counterparty_id:  int | None
    counterparty_name: str | None
    order_id:         int | None
    order_number:     str | None
    description:      str | None
    transaction_date: date
    created_at:       datetime

    class Config:
        from_attributes = True


class CashFlowSummary(BaseModel):
    total_income:  Decimal
    total_expense: Decimal
    net:           Decimal
    by_category:   list[dict]  # [{category, type, total}]


# ── Zones & cells ─────────────────────────────────────────────────────────────

class ZoneCreate(BaseModel):
    name:       str
    rows:       int = 5
    cols:       int = 5
    sort_order: int = 0


class ZoneUpdate(BaseModel):
    name:       str | None = None
    rows:       int | None = None
    cols:       int | None = None
    sort_order: int | None = None


class CellStockSet(BaseModel):
    product_id: int
    quantity:   Decimal


class CellStockOut(BaseModel):
    product_id:   int
    product_name: str
    product_sku:  str
    quantity:     Decimal

    class Config:
        from_attributes = True


class CellOut(BaseModel):
    id:    int
    code:  str
    notes: str | None
    stock: list[CellStockOut] = []

    class Config:
        from_attributes = True


class ZoneOut(BaseModel):
    id:         int
    name:       str
    rows:       int
    cols:       int
    sort_order: int
    cell_count: int
    created_at: datetime

    class Config:
        from_attributes = True


class ZoneWithCellsOut(ZoneOut):
    cells: list[CellOut] = []
