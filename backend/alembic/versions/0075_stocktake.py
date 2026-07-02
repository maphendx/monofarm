"""stocktake sessions + lines

Revision ID: 0075
Revises: 0074
Create Date: 2026-07-02
"""
import sqlalchemy as sa
from alembic import op

revision = "0075"
down_revision = "0074"
branch_labels = None
depends_on = None

_status = sa.Enum("open", "confirmed", "cancelled", name="stocktakestatus")
_scope = sa.Enum("full", "partial", name="stocktakescope")


def upgrade() -> None:
    op.create_table(
        "wh_stocktake_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("warehouse_id", sa.Integer(), sa.ForeignKey("wh_warehouses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", _status, nullable=False, server_default="open"),
        sa.Column("scope", _scope, nullable=False, server_default="full"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_wh_stocktake_sessions_organization_id", "wh_stocktake_sessions", ["organization_id"])
    op.create_index("ix_wh_stocktake_sessions_warehouse_id", "wh_stocktake_sessions", ["warehouse_id"])
    op.create_index("ix_wh_stocktake_sessions_status", "wh_stocktake_sessions", ["status"])

    op.create_table(
        "wh_stocktake_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("wh_stocktake_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("wh_products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expected_qty", sa.Numeric(12, 3), nullable=False, server_default="0"),
        sa.Column("counted_qty", sa.Numeric(12, 3), nullable=True),
        sa.Column("counted_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("counted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("session_id", "product_id", name="uq_stocktake_line"),
    )
    op.create_index("ix_wh_stocktake_lines_session_id", "wh_stocktake_lines", ["session_id"])
    op.create_index("ix_wh_stocktake_lines_product_id", "wh_stocktake_lines", ["product_id"])


def downgrade() -> None:
    op.drop_index("ix_wh_stocktake_lines_product_id", table_name="wh_stocktake_lines")
    op.drop_index("ix_wh_stocktake_lines_session_id", table_name="wh_stocktake_lines")
    op.drop_table("wh_stocktake_lines")
    op.drop_index("ix_wh_stocktake_sessions_status", table_name="wh_stocktake_sessions")
    op.drop_index("ix_wh_stocktake_sessions_warehouse_id", table_name="wh_stocktake_sessions")
    op.drop_index("ix_wh_stocktake_sessions_organization_id", table_name="wh_stocktake_sessions")
    op.drop_table("wh_stocktake_sessions")
    _status.drop(op.get_bind(), checkfirst=True)
    _scope.drop(op.get_bind(), checkfirst=True)
