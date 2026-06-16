"""purchase orders

Revision ID: 0067
Revises: 0066
Create Date: 2026-06-16
"""
from alembic import op
import sqlalchemy as sa

revision = "0067"
down_revision = "0066"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE TYPE purchaseorderstatus AS ENUM ('draft', 'received', 'cancelled')")

    op.create_table(
        "wh_purchase_orders",
        sa.Column("id",              sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("counterparty_id", sa.Integer(), sa.ForeignKey("wh_counterparties.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("warehouse_id",    sa.Integer(), sa.ForeignKey("wh_warehouses.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status",          sa.Enum("draft", "received", "cancelled", name="purchaseorderstatus"), nullable=False, server_default="draft"),
        sa.Column("notes",           sa.Text(), nullable=True),
        sa.Column("received_at",     sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by_id",   sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "wh_purchase_order_items",
        sa.Column("id",                sa.Integer(), primary_key=True),
        sa.Column("purchase_order_id", sa.Integer(), sa.ForeignKey("wh_purchase_orders.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("product_id",        sa.Integer(), sa.ForeignKey("wh_products.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("quantity",          sa.Numeric(12, 4), nullable=False),
        sa.Column("unit_cost",         sa.Numeric(14, 4), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("wh_purchase_order_items")
    op.drop_table("wh_purchase_orders")
    op.execute("DROP TYPE purchaseorderstatus")
