"""movement unit_price and total_revenue for SALE_OUT

Revision ID: 0034
Revises: 0033
Create Date: 2026-05-28
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0034"
down_revision: Union[str, None] = "0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("wh_movements", sa.Column("unit_price",    sa.Numeric(12, 4), nullable=True))
    op.add_column("wh_movements", sa.Column("total_revenue", sa.Numeric(12, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("wh_movements", "total_revenue")
    op.drop_column("wh_movements", "unit_price")
