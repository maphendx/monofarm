"""Add counterparties, confirmed order status, paid_amount, warehouse_id on items

Revision ID: 0018
Revises: 0017
Create Date: 2026-05-21
"""
import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── wh_counterparties ─────────────────────────────────────────────────────
    op.create_table(
        "wh_counterparties",
        sa.Column("id",              sa.Integer(),      nullable=False),
        sa.Column("organization_id", sa.Integer(),      nullable=False),
        sa.Column("type",            sa.Enum("supplier", "customer", "both", name="counterpartytype"), nullable=False),
        sa.Column("name",            sa.String(255),    nullable=False),
        sa.Column("email",           sa.String(255),    nullable=True),
        sa.Column("phone",           sa.String(50),     nullable=True),
        sa.Column("tax_number",      sa.String(50),     nullable=True),
        sa.Column("address",         sa.Text(),         nullable=True),
        sa.Column("notes",           sa.Text(),         nullable=True),
        sa.Column("balance",         sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("external_id",     sa.String(100),    nullable=True),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_wh_counterparties_org",         "wh_counterparties", ["organization_id"])
    op.create_index("ix_wh_counterparties_external_id", "wh_counterparties", ["external_id"])

    # ── Add 'confirmed' value to orderstatus enum ─────────────────────────────
    # ALTER TYPE ADD VALUE cannot run inside a transaction on PG<12; on PG16 it
    # can, but the new label cannot be used within the same transaction. We only
    # alter the type here and reference it in application code, so this is safe.
    op.execute("ALTER TYPE orderstatus ADD VALUE IF NOT EXISTS 'confirmed'")

    # ── Add 'keycrm' value to ordersource enum ────────────────────────────────
    op.execute("ALTER TYPE ordersource ADD VALUE IF NOT EXISTS 'keycrm'")

    # ── wh_orders: add counterparty_id and paid_amount ────────────────────────
    op.add_column(
        "wh_orders",
        sa.Column("counterparty_id", sa.Integer(), sa.ForeignKey("wh_counterparties.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column(
        "wh_orders",
        sa.Column("paid_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
    )
    op.create_index("ix_wh_orders_counterparty", "wh_orders", ["counterparty_id"])

    # ── wh_order_items: add warehouse_id ─────────────────────────────────────
    op.add_column(
        "wh_order_items",
        sa.Column("warehouse_id", sa.Integer(), sa.ForeignKey("wh_warehouses.id", ondelete="SET NULL"), nullable=True),
    )

    # ── wh_products: add cost_price (AVCO running average) ───────────────────
    op.add_column(
        "wh_products",
        sa.Column("cost_price", sa.Numeric(12, 4), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("wh_products", "cost_price")
    op.drop_column("wh_order_items", "warehouse_id")
    op.drop_index("ix_wh_orders_counterparty", table_name="wh_orders")
    op.drop_column("wh_orders", "paid_amount")
    op.drop_column("wh_orders", "counterparty_id")
    # Enum values cannot be removed in PostgreSQL without recreating the type;
    # leaving 'confirmed' and 'keycrm' in place is safe for downgrade.
    op.drop_index("ix_wh_counterparties_external_id", table_name="wh_counterparties")
    op.drop_index("ix_wh_counterparties_org",         table_name="wh_counterparties")
    op.drop_table("wh_counterparties")
    op.execute("DROP TYPE IF EXISTS counterpartytype")
