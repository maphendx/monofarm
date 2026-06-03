import enum
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean, Date, DateTime, Enum, ForeignKey,
    Integer, Numeric, String, Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


# ── Enums ─────────────────────────────────────────────────────────────────────

class WarehouseType(str, enum.Enum):
    raw      = "raw"
    wip      = "wip"
    finished = "finished"
    defect   = "defect"


class CounterpartyType(str, enum.Enum):
    supplier = "supplier"
    customer = "customer"
    both     = "both"


class SpecOpType(str, enum.Enum):
    print       = "print"
    manual      = "manual"
    postprocess = "postprocess"


class MovementType(str, enum.Enum):
    PRODUCTION_IN  = "PRODUCTION_IN"
    PRODUCTION_OUT = "PRODUCTION_OUT"
    PURCHASE_IN    = "PURCHASE_IN"
    SALE_OUT       = "SALE_OUT"
    TRANSFER       = "TRANSFER"
    ADJUSTMENT     = "ADJUSTMENT"
    DEFECT         = "DEFECT"
    RETURN_IN      = "RETURN_IN"
    WRITE_OFF      = "WRITE_OFF"


class CellMoveKind(str, enum.Enum):
    putaway  = "putaway"    # unassigned (floor) → cell
    relocate = "relocate"   # cell → cell within the same warehouse
    pick     = "pick"       # cell → out (consumed by an outbound ledger movement)
    adjust   = "adjust"     # manual correction of a cell's quantity


class BatchStatus(str, enum.Enum):
    draft     = "draft"
    active    = "active"
    paused    = "paused"
    done      = "done"
    cancelled = "cancelled"


class OrderStatus(str, enum.Enum):
    new           = "new"
    confirmed     = "confirmed"     # reserved — stock locked
    in_production = "in_production"
    ready         = "ready"
    shipped       = "shipped"
    cancelled     = "cancelled"


class OrderSource(str, enum.Enum):
    manual  = "manual"
    etsy    = "etsy"
    shopify = "shopify"
    keycrm  = "keycrm"
    horoshop = "horoshop"
    api     = "api"


class CashTxType(str, enum.Enum):
    income  = "income"
    expense = "expense"


class CashTxCategory(str, enum.Enum):
    order_payment    = "order_payment"    # customer paid for order
    supplier_payment = "supplier_payment" # we paid supplier
    salary           = "salary"
    utility          = "utility"
    refund           = "refund"
    other            = "other"


# ── Product category ──────────────────────────────────────────────────────────

class ProductCategory(Base):
    __tablename__ = "wh_product_categories"

    id:              Mapped[int]      = mapped_column(primary_key=True)
    organization_id: Mapped[int]      = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    name:            Mapped[str]      = mapped_column(String(120))
    color:           Mapped[str | None] = mapped_column(String(7), nullable=True)   # hex e.g. #e5e7eb
    sort_order:      Mapped[int]      = mapped_column(Integer, default=0)
    created_at:      Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Warehouse ─────────────────────────────────────────────────────────────────

class Warehouse(Base):
    __tablename__ = "wh_warehouses"

    id:              Mapped[int]  = mapped_column(primary_key=True)
    organization_id: Mapped[int]  = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    name:            Mapped[str]  = mapped_column(String(120))
    type:            Mapped[WarehouseType] = mapped_column(Enum(WarehouseType), nullable=False)
    location:        Mapped[str | None]   = mapped_column(String(200), nullable=True)
    is_active:       Mapped[bool]         = mapped_column(Boolean, default=True, nullable=False)
    created_at:      Mapped[datetime]     = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Counterparty ──────────────────────────────────────────────────────────────

class Counterparty(Base):
    __tablename__ = "wh_counterparties"

    id:              Mapped[int]              = mapped_column(primary_key=True)
    organization_id: Mapped[int]              = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    type:            Mapped[CounterpartyType] = mapped_column(Enum(CounterpartyType), nullable=False)
    name:            Mapped[str]              = mapped_column(String(255))
    email:           Mapped[str | None]       = mapped_column(String(255), nullable=True)
    phone:           Mapped[str | None]       = mapped_column(String(50), nullable=True)
    tax_number:      Mapped[str | None]       = mapped_column(String(50), nullable=True)
    address:         Mapped[str | None]       = mapped_column(Text, nullable=True)
    notes:           Mapped[str | None]       = mapped_column(Text, nullable=True)
    # Positive = they owe us; negative = we owe them (advances)
    balance:         Mapped[Decimal]          = mapped_column(Numeric(14, 2), default=0, nullable=False)
    # Reserved for future KeyCRM sync
    external_id:     Mapped[str | None]       = mapped_column(String(100), nullable=True, index=True)
    created_at:      Mapped[datetime]         = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Product ───────────────────────────────────────────────────────────────────

class Product(Base):
    __tablename__ = "wh_products"
    __table_args__ = (UniqueConstraint("organization_id", "sku", name="uq_wh_products_org_sku"),)

    id:              Mapped[int]  = mapped_column(primary_key=True)
    organization_id: Mapped[int]  = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    name:            Mapped[str]  = mapped_column(String(255))
    sku:             Mapped[str]  = mapped_column(String(80))
    barcode:         Mapped[str | None] = mapped_column(String(80), nullable=True)
    categories:      Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    unit:            Mapped[str]  = mapped_column(String(20), default="шт")
    description:     Mapped[str | None]      = mapped_column(Text, nullable=True)
    is_active:       Mapped[bool]            = mapped_column(Boolean, default=True, nullable=False)
    sale_price:      Mapped[Decimal | None]  = mapped_column(Numeric(12, 2), nullable=True)
    # AVCO running average cost (updated on every PURCHASE_IN)
    cost_price:      Mapped[Decimal | None]  = mapped_column(Numeric(12, 4), nullable=True)
    # Cached computed costs (updated by cost calculator endpoint)
    direct_cost:     Mapped[Decimal | None]  = mapped_column(Numeric(12, 4), nullable=True)
    full_cost:       Mapped[Decimal | None]  = mapped_column(Numeric(12, 4), nullable=True)
    # Inventory thresholds
    min_stock:       Mapped[int | None]      = mapped_column(Integer, nullable=True)
    desired_stock:   Mapped[int | None]      = mapped_column(Integer, nullable=True)
    box_limit:       Mapped[int | None]      = mapped_column(Integer, nullable=True)  # items per physical box/cell
    image_key:       Mapped[str | None]      = mapped_column(String(120), nullable=True)  # primary image cache
    created_by_id:   Mapped[int | None]      = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at:      Mapped[datetime]        = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at:      Mapped[datetime]        = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ProductImage(Base):
    __tablename__ = "wh_product_images"

    id:              Mapped[int]  = mapped_column(primary_key=True)
    product_id:      Mapped[int]  = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="CASCADE"), nullable=False, index=True)
    organization_id: Mapped[int]  = mapped_column(Integer, nullable=False, index=True)
    image_key:       Mapped[str]  = mapped_column(String(120), nullable=False)
    is_primary:      Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order:      Mapped[int]  = mapped_column(Integer, default=0, nullable=False)
    created_at:      Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Specification ─────────────────────────────────────────────────────────────

class Specification(Base):
    __tablename__ = "wh_specifications"

    id:         Mapped[int]  = mapped_column(primary_key=True)
    product_id: Mapped[int]  = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="CASCADE"), nullable=False, index=True)
    version:    Mapped[int]  = mapped_column(Integer, default=1)
    name:       Mapped[str]  = mapped_column(String(120), default="Основна")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    notes:      Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime]   = mapped_column(DateTime(timezone=True), server_default=func.now())


class SpecComponent(Base):
    __tablename__ = "wh_spec_components"

    id:               Mapped[int]  = mapped_column(primary_key=True)
    specification_id: Mapped[int]  = mapped_column(Integer, ForeignKey("wh_specifications.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id:       Mapped[int | None] = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="SET NULL"), nullable=True, index=True)
    material_id:      Mapped[int | None] = mapped_column(ForeignKey("filaments.id", ondelete="SET NULL"), nullable=True)
    name:             Mapped[str]        = mapped_column(String(120))
    quantity:         Mapped[Decimal]    = mapped_column(Numeric(12, 3), default=0)
    unit:             Mapped[str]        = mapped_column(String(10), default="g")
    unit_price:       Mapped[Decimal | None] = mapped_column(Numeric(12, 4), nullable=True)
    waste_pct:        Mapped[Decimal]        = mapped_column(Numeric(5, 2), default=0)
    sort_order:       Mapped[int]            = mapped_column(Integer, default=0)


class SpecOperation(Base):
    __tablename__ = "wh_spec_operations"

    id:               Mapped[int]  = mapped_column(primary_key=True)
    specification_id: Mapped[int]  = mapped_column(Integer, ForeignKey("wh_specifications.id", ondelete="CASCADE"), nullable=False, index=True)
    type:             Mapped[SpecOpType] = mapped_column(Enum(SpecOpType), nullable=False)
    name:             Mapped[str]  = mapped_column(String(120))
    sort_order:       Mapped[int]  = mapped_column(Integer, default=0)

    print_time_min:        Mapped[Decimal | None] = mapped_column(Numeric(8, 2), nullable=True)
    power_watts:           Mapped[int | None]     = mapped_column(Integer, nullable=True)
    labor_minutes:         Mapped[Decimal | None] = mapped_column(Numeric(8, 2), nullable=True)
    labor_rate_per_hour:   Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    explicit_cost:         Mapped[Decimal | None] = mapped_column(Numeric(10, 4), nullable=True)
    notes:                 Mapped[str | None]     = mapped_column(String(255), nullable=True)


# ── Stock ─────────────────────────────────────────────────────────────────────

class StockEntry(Base):
    __tablename__ = "wh_stock_entries"

    id:              Mapped[int]     = mapped_column(primary_key=True)
    organization_id: Mapped[int]     = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id:      Mapped[int]     = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="CASCADE"), nullable=False, index=True)
    warehouse_id:    Mapped[int]     = mapped_column(Integer, ForeignKey("wh_warehouses.id", ondelete="CASCADE"), nullable=False, index=True)
    quantity:        Mapped[Decimal] = mapped_column(Numeric(12, 3), default=0)
    reserved_qty:    Mapped[Decimal] = mapped_column(Numeric(12, 3), default=0)
    updated_at:      Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ── Movement ──────────────────────────────────────────────────────────────────

class WarehouseMovement(Base):
    __tablename__ = "wh_movements"

    id:               Mapped[int]          = mapped_column(primary_key=True)
    organization_id:  Mapped[int]          = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    type:             Mapped[MovementType] = mapped_column(Enum(MovementType), nullable=False, index=True)
    product_id:       Mapped[int]          = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="RESTRICT"), nullable=False, index=True)
    warehouse_from_id: Mapped[int | None]  = mapped_column(Integer, ForeignKey("wh_warehouses.id", ondelete="SET NULL"), nullable=True)
    warehouse_to_id:   Mapped[int | None]  = mapped_column(Integer, ForeignKey("wh_warehouses.id", ondelete="SET NULL"), nullable=True)
    quantity:          Mapped[Decimal]     = mapped_column(Numeric(12, 3))
    unit:              Mapped[str]         = mapped_column(String(10), default="шт")
    unit_cost:         Mapped[Decimal | None] = mapped_column(Numeric(12, 4), nullable=True)
    total_cost:        Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    unit_price:        Mapped[Decimal | None] = mapped_column(Numeric(12, 4), nullable=True)
    total_revenue:     Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    batch_id:          Mapped[int | None]     = mapped_column(Integer, ForeignKey("wh_batches.id", ondelete="SET NULL"), nullable=True)
    order_id:          Mapped[int | None]     = mapped_column(Integer, ForeignKey("wh_orders.id", ondelete="SET NULL"), nullable=True)
    reason:            Mapped[str | None]     = mapped_column(String(255), nullable=True)
    created_by_id:     Mapped[int | None]     = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at:        Mapped[datetime]       = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


# ── ProductionBatch ───────────────────────────────────────────────────────────

class ProductionBatch(Base):
    __tablename__ = "wh_batches"

    id:               Mapped[int]         = mapped_column(primary_key=True)
    organization_id:  Mapped[int]         = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id:       Mapped[int]         = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="RESTRICT"), nullable=False, index=True)
    specification_id: Mapped[int | None]  = mapped_column(Integer, ForeignKey("wh_specifications.id", ondelete="SET NULL"), nullable=True)
    target_qty:       Mapped[int]         = mapped_column(Integer, default=0)
    printed_qty:      Mapped[int]         = mapped_column(Integer, default=0)
    good_qty:         Mapped[int]         = mapped_column(Integer, default=0)
    defect_qty:       Mapped[int]         = mapped_column(Integer, default=0)
    status:           Mapped[BatchStatus] = mapped_column(Enum(BatchStatus), default=BatchStatus.draft, nullable=False, index=True)
    due_date:         Mapped[date | None] = mapped_column(Date, nullable=True)
    order_id:         Mapped[int | None]  = mapped_column(Integer, ForeignKey("wh_orders.id", ondelete="SET NULL"), nullable=True)
    print_task_id:    Mapped[int | None]  = mapped_column(Integer, ForeignKey("print_tasks.id", ondelete="SET NULL"), nullable=True, index=True)
    notes:            Mapped[str | None]  = mapped_column(Text, nullable=True)
    created_by_id:    Mapped[int | None]  = mapped_column(ForeignKey("users.id"), nullable=True)
    assigned_to_id:   Mapped[int | None]  = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at:       Mapped[datetime]    = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at:       Mapped[datetime]    = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ── AssemblySession ───────────────────────────────────────────────────────────

class AssemblySession(Base):
    """One work session of one worker on one production batch.

    A session captures: who worked, when, how many units were completed.
    Multiple sessions per batch are allowed (shift changes, breaks, etc.).
    Closing a session is non-destructive — it just sets closed_at.
    The batch's good_qty / defect_qty are updated when the session is closed.
    """
    __tablename__ = "wh_assembly_sessions"

    id:              Mapped[int]          = mapped_column(primary_key=True)
    organization_id: Mapped[int]          = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    batch_id:        Mapped[int]          = mapped_column(Integer, ForeignKey("wh_batches.id", ondelete="CASCADE"), nullable=False, index=True)
    worker_id:       Mapped[int]          = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    started_at:      Mapped[datetime]     = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    closed_at:       Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    units_good:      Mapped[int]          = mapped_column(Integer, default=0, nullable=False)
    units_defective: Mapped[int]          = mapped_column(Integer, default=0, nullable=False)
    notes:           Mapped[str | None]   = mapped_column(Text, nullable=True)


# ── Order ─────────────────────────────────────────────────────────────────────

class Order(Base):
    __tablename__ = "wh_orders"

    id:               Mapped[int]         = mapped_column(primary_key=True)
    organization_id:  Mapped[int]         = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    order_number:     Mapped[str]         = mapped_column(String(80))
    counterparty_id:  Mapped[int | None]  = mapped_column(Integer, ForeignKey("wh_counterparties.id", ondelete="SET NULL"), nullable=True, index=True)
    customer_name:    Mapped[str | None]  = mapped_column(String(255), nullable=True)  # fallback if no counterparty
    source:           Mapped[OrderSource] = mapped_column(Enum(OrderSource), default=OrderSource.manual, nullable=False)
    external_id:      Mapped[str | None]  = mapped_column(String(120), nullable=True, index=True)
    external_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status:           Mapped[OrderStatus] = mapped_column(Enum(OrderStatus), default=OrderStatus.new, nullable=False, index=True)
    total_amount:     Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    paid_amount:      Mapped[Decimal]        = mapped_column(Numeric(12, 2), default=0, nullable=False)
    currency:         Mapped[str]            = mapped_column(String(3), default="UAH")
    due_date:         Mapped[date | None]    = mapped_column(Date, nullable=True)
    notes:            Mapped[str | None]     = mapped_column(Text, nullable=True)
    created_by_id:    Mapped[int | None]     = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at:       Mapped[datetime]       = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at:       Mapped[datetime]       = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class OrderItem(Base):
    __tablename__ = "wh_order_items"

    id:           Mapped[int]     = mapped_column(primary_key=True)
    order_id:     Mapped[int]     = mapped_column(Integer, ForeignKey("wh_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id:   Mapped[int]     = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="RESTRICT"), nullable=False)
    warehouse_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("wh_warehouses.id", ondelete="SET NULL"), nullable=True)
    quantity:     Mapped[int]     = mapped_column(Integer, default=1)
    unit_price:   Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    total_price:  Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)


# ── Warehouse zones & cells ───────────────────────────────────────────────────

class OrderPayment(Base):
    __tablename__ = "wh_order_payments"

    id:              Mapped[int]           = mapped_column(primary_key=True)
    organization_id: Mapped[int]           = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    order_id:        Mapped[int]           = mapped_column(Integer, ForeignKey("wh_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    amount:          Mapped[Decimal]       = mapped_column(Numeric(12, 2), nullable=False)
    paid_at:         Mapped[date]          = mapped_column(Date, nullable=False)
    method:          Mapped[str | None]    = mapped_column(String(80), nullable=True)
    note:            Mapped[str | None]    = mapped_column(String(500), nullable=True)
    cashflow_id:     Mapped[int | None]    = mapped_column(Integer, ForeignKey("wh_cash_transactions.id", ondelete="SET NULL"), nullable=True)
    created_at:      Mapped[datetime]      = mapped_column(DateTime(timezone=True), server_default=func.now())


class HoroshopSyncEvent(Base):
    __tablename__ = "horoshop_sync_events"

    id:                Mapped[int]      = mapped_column(primary_key=True)
    organization_id:   Mapped[int]      = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type:        Mapped[str]      = mapped_column(String(80), nullable=False)
    external_order_id: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    status:            Mapped[str]      = mapped_column(String(24), default="pending", server_default="pending", nullable=False)
    message:           Mapped[str | None] = mapped_column(Text, nullable=True)
    payload:           Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at:        Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    processed_at:      Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WarehouseZone(Base):
    __tablename__ = "wh_zones"

    id:              Mapped[int]      = mapped_column(primary_key=True)
    organization_id: Mapped[int]      = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    warehouse_id:    Mapped[int]      = mapped_column(Integer, ForeignKey("wh_warehouses.id", ondelete="CASCADE"), nullable=False, index=True)
    name:            Mapped[str]      = mapped_column(String(120))
    rows:            Mapped[int]      = mapped_column(Integer, default=5)
    cols:            Mapped[int]      = mapped_column(Integer, default=5)
    sort_order:      Mapped[int]      = mapped_column(Integer, default=0)
    created_at:      Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WarehouseCell(Base):
    __tablename__ = "wh_cells"

    id:         Mapped[int]           = mapped_column(primary_key=True)
    zone_id:    Mapped[int]           = mapped_column(Integer, ForeignKey("wh_zones.id", ondelete="CASCADE"), nullable=False, index=True)
    code:       Mapped[str]           = mapped_column(String(20))   # e.g. A1, B3
    notes:      Mapped[str | None]    = mapped_column(String(500), nullable=True)


class CellStock(Base):
    __tablename__ = "wh_cell_stock"

    id:         Mapped[int]     = mapped_column(primary_key=True)
    cell_id:    Mapped[int]     = mapped_column(Integer, ForeignKey("wh_cells.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id: Mapped[int]     = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="CASCADE"), nullable=False, index=True)
    quantity:   Mapped[Decimal] = mapped_column(Numeric(12, 4), default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    product: Mapped["Product"] = relationship(lazy="joined")


class CellMovement(Base):
    """Audit log of physical relocations between cells / the unassigned pool.

    These never change a warehouse's total stock — they only record where
    inside the warehouse a product physically moved. cell_from_id/cell_to_id
    are NULL when the counterpart is the unassigned (floor) pool.
    """
    __tablename__ = "wh_cell_movements"

    id:              Mapped[int]          = mapped_column(primary_key=True)
    organization_id: Mapped[int]          = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id:      Mapped[int]          = mapped_column(Integer, ForeignKey("wh_products.id", ondelete="CASCADE"), nullable=False, index=True)
    cell_from_id:    Mapped[int | None]   = mapped_column(Integer, ForeignKey("wh_cells.id", ondelete="SET NULL"), nullable=True)
    cell_to_id:      Mapped[int | None]   = mapped_column(Integer, ForeignKey("wh_cells.id", ondelete="SET NULL"), nullable=True)
    quantity:        Mapped[Decimal]      = mapped_column(Numeric(12, 4), nullable=False)
    kind:            Mapped[CellMoveKind] = mapped_column(Enum(CellMoveKind), nullable=False, index=True)
    movement_id:     Mapped[int | None]   = mapped_column(Integer, ForeignKey("wh_movements.id", ondelete="SET NULL"), nullable=True)
    created_by_id:   Mapped[int | None]   = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at:      Mapped[datetime]     = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


# ── Cash Flow ─────────────────────────────────────────────────────────────────

class CashTransaction(Base):
    __tablename__ = "wh_cash_transactions"

    id:               Mapped[int]             = mapped_column(primary_key=True)
    organization_id:  Mapped[int]             = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    type:             Mapped[CashTxType]       = mapped_column(Enum(CashTxType), nullable=False, index=True)
    category:         Mapped[CashTxCategory]  = mapped_column(Enum(CashTxCategory), nullable=False)
    amount:           Mapped[Decimal]          = mapped_column(Numeric(14, 2), nullable=False)  # always positive
    counterparty_id:  Mapped[int | None]       = mapped_column(Integer, ForeignKey("wh_counterparties.id", ondelete="SET NULL"), nullable=True, index=True)
    order_id:         Mapped[int | None]       = mapped_column(Integer, ForeignKey("wh_orders.id", ondelete="SET NULL"), nullable=True, index=True)
    description:      Mapped[str | None]       = mapped_column(String(500), nullable=True)
    transaction_date: Mapped[date]             = mapped_column(Date, nullable=False, index=True)
    created_by_id:    Mapped[int | None]       = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at:       Mapped[datetime]         = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Label Templates ───────────────────────────────────────────────────────────

class LabelTemplate(Base):
    __tablename__ = "wh_label_templates"

    id:              Mapped[int]         = mapped_column(primary_key=True)
    organization_id: Mapped[int]         = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    name:            Mapped[str]         = mapped_column(String(100), nullable=False)
    item_type:       Mapped[str]         = mapped_column(String(20), nullable=False, default="universal")  # cell|product|action|universal
    width_mm:        Mapped[float]       = mapped_column(Numeric(8, 2), nullable=False, default=57.0)
    height_mm:       Mapped[float]       = mapped_column(Numeric(8, 2), nullable=False, default=32.0)
    elements:        Mapped[list]        = mapped_column(JSONB, nullable=False, default=list)
    is_default:      Mapped[bool]        = mapped_column(Boolean, nullable=False, default=False)
    created_at:      Mapped[datetime]    = mapped_column(DateTime(timezone=True), server_default=func.now())
