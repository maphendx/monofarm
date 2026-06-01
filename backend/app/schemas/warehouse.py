import enum
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
    image_url:     str | None = None
    created_at:    datetime

    class Config:
        from_attributes = True


class ProductImageOut(BaseModel):
    id:         int
    image_url:  str
    is_primary: bool
    sort_order: int

    class Config:
        from_attributes = True


# ── Specification ─────────────────────────────────────────────────────────────

class SpecComponentCreate(BaseModel):
    name:        str
    product_id:  int | None = None
    material_id: int | None = None
    quantity:    Decimal
    unit:        str = "g"
    unit_price:  Decimal | None = None
    waste_pct:   Decimal = Decimal("0")
    sort_order:  int = 0


class SpecComponentOut(BaseModel):
    id:           int
    name:         str
    product_id:   int | None = None
    product_name: str | None = None
    material_id:  int | None
    quantity:     Decimal
    unit:         str
    unit_price:   Decimal | None
    waste_pct:    Decimal
    sort_order:   int

    class Config:
        from_attributes = True


class BatchComponentOut(BaseModel):
    id:              int
    name:            str
    product_id:      int | None
    product_name:    str | None
    quantity:        Decimal
    unit:            str
    total_qty:       Decimal
    available_stock: Decimal | None
    is_sufficient:   bool


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
    assigned_qty:   Decimal = Decimal(0)    # sum allocated to cells in this warehouse
    unassigned_qty: Decimal = Decimal(0)    # quantity - assigned_qty (floor stock awaiting putaway)
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
    cell_from_id:      int | None = None   # optional bin to pick out of (outbound / transfer)
    cell_to_id:        int | None = None   # optional bin to put away into (inbound / transfer)


_MOVEMENT_DIRECTION: dict[str, str] = {
    "PURCHASE_IN":    "in",
    "PRODUCTION_IN":  "in",
    "RETURN_IN":      "in",
    "ADJUSTMENT":     "in",
    "SALE_OUT":       "out",
    "PRODUCTION_OUT": "out",
    "DEFECT":         "transfer",
    "WRITE_OFF":      "out",
    "TRANSFER":       "transfer",
}


class MovementOut(BaseModel):
    id:                int
    type:              MovementType
    direction:         str           # "in" | "out" | "transfer" — canonical sign from backend
    product_id:        int
    product_name:      str
    warehouse_from_id: int | None
    warehouse_to_id:   int | None
    quantity:          Decimal
    unit:              str
    unit_cost:         Decimal | None
    total_cost:        Decimal | None
    unit_price:        Decimal | None = None
    total_revenue:     Decimal | None = None
    reason:            str | None
    batch_id:          int | None
    order_id:          int | None
    created_at:        datetime

    class Config:
        from_attributes = True


class MovementListOut(BaseModel):
    items:       list[MovementOut]
    next_cursor: str | None
    has_more:    bool
    total:       int | None  # only on first page (cursor is None)


# ── ProductionBatch ───────────────────────────────────────────────────────────

class BatchCreate(BaseModel):
    product_id:       int
    specification_id: int | None = None
    target_qty:       int
    due_date:         date | None = None
    notes:            str | None = None
    order_id:         int | None = None
    print_task_id:    int | None = None


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
    status:            BatchStatus
    due_date:          date | None
    order_id:          int | None
    print_task_id:     int | None = None
    print_task_title:  str | None = None
    notes:             str | None
    components:        list[BatchComponentOut] = []
    created_at:        datetime
    updated_at:        datetime

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
    # paid_amount intentionally removed — use POST /orders/{id}/payments instead


class OrderPaymentCreate(BaseModel):
    amount: Decimal
    paid_at: date | None = None
    method:  str | None = None
    note:    str | None = None


class OrderPaymentOut(BaseModel):
    id:          int
    order_id:    int
    amount:      Decimal
    paid_at:     date
    method:      str | None
    note:        str | None
    cashflow_id: int | None
    created_at:  datetime

    class Config:
        from_attributes = True


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
    outstanding:      Decimal
    payment_status:   str             # "unpaid" | "partial" | "paid"
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


class CellAssign(BaseModel):
    product_id: int
    quantity:   Decimal


class CellStockOut(BaseModel):
    product_id:   int
    product_name: str
    product_sku:  str
    quantity:     Decimal
    image_url:    str | None = None

    class Config:
        from_attributes = True


class CellDetailOut(BaseModel):
    cell_id:        int
    cell_code:      str
    cell_notes:     str | None
    zone_id:        int
    zone_name:      str
    warehouse_id:   int
    warehouse_name: str
    stock:          list[CellStockOut] = []


class ScanResult(BaseModel):
    type:    str   # "cell" | "product"
    cell:    CellDetailOut | None = None
    product: ProductOut    | None = None


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


class ZoneOverviewOut(ZoneOut):
    warehouse_id:   int
    warehouse_name: str
    filled_cells:   int   # cells with at least one product


# ── Bin operations ──────────────────────────────────────────────────────────

class PutawayRequest(BaseModel):
    product_id: int
    quantity:   Decimal


class RelocateRequest(BaseModel):
    product_id:   int
    from_cell_id: int
    to_cell_id:   int
    quantity:     Decimal


class ScanAction(str, enum.Enum):
    """Operation chosen by scanning a functional ACTION QR."""
    write_off      = "write_off"       # remove from a cell + warehouse ledger (WRITE_OFF)
    transfer       = "transfer"        # cell → cell; same warehouse = relocate, else TRANSFER
    receive        = "receive"         # book into a cell (PURCHASE_IN); unit_cost optional → AVCO
    stocktake      = "stocktake"       # set a cell to the counted qty and correct the total
    sale_out       = "sale_out"        # ship from a cell (SALE_OUT); unit_price optional → revenue
    defect         = "defect"          # mark defective, remove from a cell (DEFECT)
    production_in  = "production_in"    # book finished goods into a cell (PRODUCTION_IN)
    production_out = "production_out"   # issue components to production from a cell (PRODUCTION_OUT)


class ScanActionRequest(BaseModel):
    action:     ScanAction
    product_id: int
    quantity:   Decimal
    cell_id:    int                    # source (out/transfer/stocktake) or target (in)
    to_cell_id: int | None = None      # transfer destination
    unit_cost:  Decimal | None = None  # receive only, optional
    unit_price: Decimal | None = None  # sale_out only, optional


class ScanActionResult(BaseModel):
    message: str


class UnassignedItemOut(BaseModel):
    product_id:   int
    product_name: str
    product_sku:  str
    unit:         str
    unassigned:   Decimal


class ProductCellLocationOut(BaseModel):
    cell_id:   int
    zone_name: str
    code:      str
    quantity:  Decimal


class ProductWarehouseLocationOut(BaseModel):
    warehouse_id:   int
    warehouse_name: str
    cells:          list[ProductCellLocationOut] = []
    unassigned:     Decimal
    total:          Decimal


class ProductLocationsOut(BaseModel):
    product_id: int
    warehouses: list[ProductWarehouseLocationOut] = []


class CellNotesUpdate(BaseModel):
    notes: str | None = None


class ShipPick(BaseModel):
    product_id: int
    cell_id:    int
    quantity:   Decimal


class ShipRequest(BaseModel):
    picks: list[ShipPick] = []


class CellMovementOut(BaseModel):
    id:            int
    product_id:    int
    product_name:  str
    quantity:      Decimal
    kind:          str
    cell_from:     str | None    # "Zone A1" or None for the unassigned pool
    cell_to:       str | None
    created_at:    datetime

    class Config:
        from_attributes = True
