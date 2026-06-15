"""warehouse: add bank_accounts table and bank_account_id on cash_transactions

Revision ID: 0065
Revises: 0064
Create Date: 2026-06-15
"""
import sqlalchemy as sa
from alembic import op

revision = "0065"
down_revision = "0064"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wh_bank_accounts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column(
            "status",
            sa.Enum("open", "closed", name="bankaccountstatus"),
            nullable=False,
            server_default="open",
        ),
        sa.Column("balance", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("initial_balance", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("initial_balance_date", sa.Date(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_wh_bank_accounts_org", "wh_bank_accounts", ["organization_id"])

    op.add_column(
        "wh_cash_transactions",
        sa.Column("bank_account_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_wh_cash_tx_bank_account",
        "wh_cash_transactions",
        "wh_bank_accounts",
        ["bank_account_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_wh_cash_tx_bank_account", "wh_cash_transactions", ["bank_account_id"])


def downgrade() -> None:
    op.drop_index("ix_wh_cash_tx_bank_account", table_name="wh_cash_transactions")
    op.drop_constraint("fk_wh_cash_tx_bank_account", "wh_cash_transactions", type_="foreignkey")
    op.drop_column("wh_cash_transactions", "bank_account_id")
    op.drop_index("ix_wh_bank_accounts_org", table_name="wh_bank_accounts")
    op.drop_table("wh_bank_accounts")
    op.execute("DROP TYPE IF EXISTS bankaccountstatus")
