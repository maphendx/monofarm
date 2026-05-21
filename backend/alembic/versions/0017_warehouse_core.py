"""Add warehouse module core tables

Revision ID: 0017
Revises: 0016
Create Date: 2026-05-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # wh_warehouses
    op.create_table(
        "wh_warehouses",
        sa.Column("id",              sa.Integer(),     nullable=False),
        sa.Column("organization_id", sa.Integer(),     nullable=False),
        sa.Column("name",            sa.String(120),   nullable=False),
        sa.Column("type",            sa.Enum("raw", "wip", "finished", "defect", name="warehousetype"), nullable=False),
        sa.Column("location",        sa.String(200),   nullable=True),
        sa.Column("is_active",       sa.Boolean(),     nullable=False, server_default="true"),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_wh_warehouses_org", "wh_warehouses", ["organization_id"])

    # wh_products
    op.create_table(
        "wh_products",
        sa.Column("id",              sa.Integer(),     nullable=False),
        sa.Column("organization_id", sa.Integer(),     nullable=False),
        sa.Column("name",            sa.String(255),   nullable=False),
        sa.Column("sku",             sa.String(80),    nullable=False),
        sa.Column("categories",      sa.JSON(),        nullable=False, server_default="[]"),
        sa.Column("unit",            sa.String(20),    nullable=False, server_default="шт"),
        sa.Column("description",     sa.Text(),        nullable=True),
        sa.Column("is_active",       sa.Boolean(),     nullable=False, server_default="true"),
        sa.Column("sale_price",      sa.Numeric(12, 2), nullable=True),
        sa.Column("direct_cost",     sa.Numeric(12, 4), nullable=True),
        sa.Column("full_cost",       sa.Numeric(12, 4), nullable=True),
        sa.Column("created_by_id",   sa.Integer(),     nullable=True),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_id"],   ["users.id"]),
    )
    op.create_index("ix_wh_products_org", "wh_products", ["organization_id"])

    # wh_specifications
    op.create_table(
        "wh_specifications",
        sa.Column("id",         sa.Integer(),   nullable=False),
        sa.Column("product_id", sa.Integer(),   nullable=False),
        sa.Column("version",    sa.Integer(),   nullable=False, server_default="1"),
        sa.Column("name",       sa.String(120), nullable=False, server_default="Основна"),
        sa.Column("is_default", sa.Boolean(),   nullable=False, server_default="false"),
        sa.Column("notes",      sa.Text(),      nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["product_id"], ["wh_products.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_wh_specifications_product", "wh_specifications", ["product_id"])

    # wh_spec_components
    op.create_table(
        "wh_spec_components",
        sa.Column("id",               sa.Integer(),     nullable=False),
        sa.Column("specification_id", sa.Integer(),     nullable=False),
        sa.Column("material_id",      sa.Integer(),     nullable=True),
        sa.Column("name",             sa.String(120),   nullable=False),
        sa.Column("quantity",         sa.Numeric(12, 3), nullable=False, server_default="0"),
        sa.Column("unit",             sa.String(10),    nullable=False, server_default="g"),
        sa.Column("unit_price",       sa.Numeric(12, 4), nullable=True),
        sa.Column("waste_pct",        sa.Numeric(5, 2),  nullable=False, server_default="0"),
        sa.Column("sort_order",       sa.Integer(),     nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["specification_id"], ["wh_specifications.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["material_id"], ["filaments.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_wh_spec_components_spec", "wh_spec_components", ["specification_id"])

    # wh_spec_operations
    op.create_table(
        "wh_spec_operations",
        sa.Column("id",               sa.Integer(),   nullable=False),
        sa.Column("specification_id", sa.Integer(),   nullable=False),
        sa.Column("type",             sa.Enum("print", "manual", "postprocess", name="specoptype"), nullable=False),
        sa.Column("name",             sa.String(120), nullable=False),
        sa.Column("sort_order",       sa.Integer(),   nullable=False, server_default="0"),
        sa.Column("print_time_min",        sa.Numeric(8, 2),  nullable=True),
        sa.Column("power_watts",           sa.Integer(),      nullable=True),
        sa.Column("labor_minutes",         sa.Numeric(8, 2),  nullable=True),
        sa.Column("labor_rate_per_hour",   sa.Numeric(10, 2), nullable=True),
        sa.Column("explicit_cost",         sa.Numeric(10, 4), nullable=True),
        sa.Column("notes",                 sa.String(255),    nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["specification_id"], ["wh_specifications.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_wh_spec_operations_spec", "wh_spec_operations", ["specification_id"])

    # wh_orders (before batches — batches have FK to orders)
    op.create_table(
        "wh_orders",
        sa.Column("id",              sa.Integer(),   nullable=False),
        sa.Column("organization_id", sa.Integer(),   nullable=False),
        sa.Column("order_number",    sa.String(80),  nullable=False),
        sa.Column("customer_name",   sa.String(255), nullable=True),
        sa.Column("source",          sa.Enum("manual", "etsy", "shopify", "api", name="ordersource"), nullable=False, server_default="manual"),
        sa.Column("status",          sa.Enum("new", "in_production", "ready", "shipped", "cancelled", name="orderstatus"), nullable=False, server_default="new"),
        sa.Column("total_amount",    sa.Numeric(12, 2), nullable=True),
        sa.Column("currency",        sa.String(3),   nullable=False, server_default="UAH"),
        sa.Column("due_date",        sa.Date(),      nullable=True),
        sa.Column("notes",           sa.Text(),      nullable=True),
        sa.Column("created_by_id",   sa.Integer(),   nullable=True),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_id"],   ["users.id"]),
    )
    op.create_index("ix_wh_orders_org",    "wh_orders", ["organization_id"])
    op.create_index("ix_wh_orders_status", "wh_orders", ["status"])

    # wh_order_items
    op.create_table(
        "wh_order_items",
        sa.Column("id",          sa.Integer(),      nullable=False),
        sa.Column("order_id",    sa.Integer(),      nullable=False),
        sa.Column("product_id",  sa.Integer(),      nullable=False),
        sa.Column("quantity",    sa.Integer(),      nullable=False, server_default="1"),
        sa.Column("unit_price",  sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("total_price", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["order_id"],   ["wh_orders.id"],   ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["wh_products.id"], ondelete="RESTRICT"),
    )
    op.create_index("ix_wh_order_items_order", "wh_order_items", ["order_id"])

    # wh_batches
    op.create_table(
        "wh_batches",
        sa.Column("id",               sa.Integer(), nullable=False),
        sa.Column("organization_id",  sa.Integer(), nullable=False),
        sa.Column("product_id",       sa.Integer(), nullable=False),
        sa.Column("specification_id", sa.Integer(), nullable=True),
        sa.Column("target_qty",   sa.Integer(), nullable=False, server_default="0"),
        sa.Column("printed_qty",  sa.Integer(), nullable=False, server_default="0"),
        sa.Column("good_qty",     sa.Integer(), nullable=False, server_default="0"),
        sa.Column("defect_qty",   sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status",       sa.Enum("draft", "active", "paused", "done", "cancelled", name="batchstatus"), nullable=False, server_default="draft"),
        sa.Column("due_date",     sa.Date(),    nullable=True),
        sa.Column("order_id",     sa.Integer(), nullable=True),
        sa.Column("notes",        sa.Text(),    nullable=True),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("created_at",   sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at",   sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"],  ["organizations.id"],   ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"],       ["wh_products.id"],     ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["specification_id"], ["wh_specifications.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["order_id"],         ["wh_orders.id"],       ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_id"],    ["users.id"]),
    )
    op.create_index("ix_wh_batches_org",    "wh_batches", ["organization_id"])
    op.create_index("ix_wh_batches_status", "wh_batches", ["status"])

    # wh_stock_entries
    op.create_table(
        "wh_stock_entries",
        sa.Column("id",              sa.Integer(),      nullable=False),
        sa.Column("organization_id", sa.Integer(),      nullable=False),
        sa.Column("product_id",      sa.Integer(),      nullable=False),
        sa.Column("warehouse_id",    sa.Integer(),      nullable=False),
        sa.Column("quantity",        sa.Numeric(12, 3), nullable=False, server_default="0"),
        sa.Column("reserved_qty",    sa.Numeric(12, 3), nullable=False, server_default="0"),
        sa.Column("updated_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"],  ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"],      ["wh_products.id"],    ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["warehouse_id"],    ["wh_warehouses.id"],  ondelete="CASCADE"),
    )
    op.create_index("ix_wh_stock_entries_org",       "wh_stock_entries", ["organization_id"])
    op.create_index("ix_wh_stock_entries_product",   "wh_stock_entries", ["product_id"])
    op.create_index("ix_wh_stock_entries_warehouse", "wh_stock_entries", ["warehouse_id"])

    # wh_movements (last — has FKs to batches and orders)
    op.create_table(
        "wh_movements",
        sa.Column("id",               sa.Integer(),      nullable=False),
        sa.Column("organization_id",  sa.Integer(),      nullable=False),
        sa.Column("type",             sa.Enum("PRODUCTION_IN", "PRODUCTION_OUT", "PURCHASE_IN", "SALE_OUT", "TRANSFER", "ADJUSTMENT", "DEFECT", name="movementtype"), nullable=False),
        sa.Column("product_id",       sa.Integer(),      nullable=False),
        sa.Column("warehouse_from_id", sa.Integer(),     nullable=True),
        sa.Column("warehouse_to_id",   sa.Integer(),     nullable=True),
        sa.Column("quantity",          sa.Numeric(12, 3), nullable=False),
        sa.Column("unit",              sa.String(10),    nullable=False, server_default="шт"),
        sa.Column("unit_cost",         sa.Numeric(12, 4), nullable=True),
        sa.Column("total_cost",        sa.Numeric(12, 2), nullable=True),
        sa.Column("batch_id",          sa.Integer(),     nullable=True),
        sa.Column("order_id",          sa.Integer(),     nullable=True),
        sa.Column("reason",            sa.String(255),   nullable=True),
        sa.Column("created_by_id",     sa.Integer(),     nullable=True),
        sa.Column("created_at",        sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"],   ["organizations.id"],  ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"],        ["wh_products.id"],    ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["warehouse_from_id"], ["wh_warehouses.id"],  ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["warehouse_to_id"],   ["wh_warehouses.id"],  ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["batch_id"],          ["wh_batches.id"],     ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["order_id"],          ["wh_orders.id"],      ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_id"],     ["users.id"]),
    )
    op.create_index("ix_wh_movements_org",        "wh_movements", ["organization_id"])
    op.create_index("ix_wh_movements_type",       "wh_movements", ["type"])
    op.create_index("ix_wh_movements_product",    "wh_movements", ["product_id"])
    op.create_index("ix_wh_movements_created_at", "wh_movements", ["created_at"])


def downgrade() -> None:
    op.drop_table("wh_movements")
    op.drop_table("wh_stock_entries")
    op.drop_table("wh_batches")
    op.drop_table("wh_order_items")
    op.drop_table("wh_orders")
    op.drop_table("wh_spec_operations")
    op.drop_table("wh_spec_components")
    op.drop_table("wh_specifications")
    op.drop_table("wh_products")
    op.drop_table("wh_warehouses")
    op.execute("DROP TYPE IF EXISTS movementtype")
    op.execute("DROP TYPE IF EXISTS batchstatus")
    op.execute("DROP TYPE IF EXISTS orderstatus")
    op.execute("DROP TYPE IF EXISTS ordersource")
    op.execute("DROP TYPE IF EXISTS specoptype")
    op.execute("DROP TYPE IF EXISTS warehousetype")
