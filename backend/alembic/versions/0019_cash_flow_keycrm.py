"""Add cash flow transactions and KeyCRM integration fields

Revision ID: 0019
Revises: 0018
Create Date: 2026-05-21
"""
import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── wh_cash_transactions ──────────────────────────────────────────────────
    op.create_table(
        "wh_cash_transactions",
        sa.Column("id",               sa.Integer(),      nullable=False),
        sa.Column("organization_id",  sa.Integer(),      nullable=False),
        sa.Column("type",             sa.Enum("income", "expense", name="cashtxtype"), nullable=False),
        sa.Column("category",         sa.Enum(
            "order_payment", "supplier_payment", "salary",
            "utility", "refund", "other", name="cashtxcategory",
        ), nullable=False),
        sa.Column("amount",           sa.Numeric(14, 2), nullable=False),
        sa.Column("counterparty_id",  sa.Integer(),      nullable=True),
        sa.Column("order_id",         sa.Integer(),      nullable=True),
        sa.Column("description",      sa.String(500),    nullable=True),
        sa.Column("transaction_date", sa.Date(),         nullable=False),
        sa.Column("created_by_id",    sa.Integer(),      nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"],  ["organizations.id"],      ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["counterparty_id"],  ["wh_counterparties.id"],  ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["order_id"],         ["wh_orders.id"],          ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_id"],    ["users.id"]),
    )
    op.create_index("ix_wh_cash_tx_org",        "wh_cash_transactions", ["organization_id"])
    op.create_index("ix_wh_cash_tx_type",       "wh_cash_transactions", ["type"])
    op.create_index("ix_wh_cash_tx_date",       "wh_cash_transactions", ["transaction_date"])
    op.create_index("ix_wh_cash_tx_cp",         "wh_cash_transactions", ["counterparty_id"])
    op.create_index("ix_wh_cash_tx_order",      "wh_cash_transactions", ["order_id"])

    # ── organizations: KeyCRM credentials ────────────────────────────────────
    op.add_column("organizations", sa.Column("keycrm_api_key",        sa.String(255), nullable=False, server_default=""))
    op.add_column("organizations", sa.Column("keycrm_webhook_secret", sa.String(255), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("organizations", "keycrm_webhook_secret")
    op.drop_column("organizations", "keycrm_api_key")
    op.drop_index("ix_wh_cash_tx_order",   table_name="wh_cash_transactions")
    op.drop_index("ix_wh_cash_tx_cp",      table_name="wh_cash_transactions")
    op.drop_index("ix_wh_cash_tx_date",    table_name="wh_cash_transactions")
    op.drop_index("ix_wh_cash_tx_type",    table_name="wh_cash_transactions")
    op.drop_index("ix_wh_cash_tx_org",     table_name="wh_cash_transactions")
    op.drop_table("wh_cash_transactions")
    op.execute("DROP TYPE IF EXISTS cashtxtype")
    op.execute("DROP TYPE IF EXISTS cashtxcategory")
