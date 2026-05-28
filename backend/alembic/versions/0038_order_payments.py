"""order payments log

Revision ID: 0038
Revises: 0037
Create Date: 2026-05-28
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0038"
down_revision: Union[str, None] = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wh_order_payments",
        sa.Column("id",              sa.Integer(),                   primary_key=True),
        sa.Column("organization_id", sa.Integer(),                   nullable=False),
        sa.Column("order_id",        sa.Integer(),                   nullable=False),
        sa.Column("amount",          sa.Numeric(12, 2),              nullable=False),
        sa.Column("paid_at",         sa.Date(),                      nullable=False),
        sa.Column("method",          sa.String(80),                  nullable=True),
        sa.Column("note",            sa.String(500),                 nullable=True),
        sa.Column("cashflow_id",     sa.Integer(),                   nullable=True),
        sa.Column("created_at",      sa.DateTime(timezone=True),     server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["order_id"],        ["wh_orders.id"],     ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["cashflow_id"],     ["wh_cash_transactions.id"], ondelete="SET NULL"),
        sa.CheckConstraint("amount > 0", name="ck_order_payments_amount_positive"),
    )
    op.create_index("ix_wh_order_payments_order_id", "wh_order_payments", ["order_id"])
    op.create_index("ix_wh_order_payments_org_id",   "wh_order_payments", ["organization_id"])

    # Backfill: migrate existing paid_amount → one historical payment row (no cashflow!)
    conn = op.get_bind()
    conn.execute(sa.text("""
        INSERT INTO wh_order_payments (organization_id, order_id, amount, paid_at, note, cashflow_id)
        SELECT organization_id, id, paid_amount, created_at::date,
               'Перенесено до впровадження логу', NULL
        FROM wh_orders
        WHERE paid_amount > 0
    """))


def downgrade() -> None:
    op.drop_index("ix_wh_order_payments_org_id",   table_name="wh_order_payments")
    op.drop_index("ix_wh_order_payments_order_id", table_name="wh_order_payments")
    op.drop_table("wh_order_payments")
