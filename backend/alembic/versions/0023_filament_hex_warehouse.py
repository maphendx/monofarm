"""filament hex_color and warehouse_product_id

Revision ID: 0023
Revises: 0022
Create Date: 2026-05-24
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: Union[str, None] = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("filaments", sa.Column("hex_color", sa.String(7), nullable=True))
    op.add_column("filaments", sa.Column(
        "warehouse_product_id", sa.Integer,
        sa.ForeignKey("wh_products.id", ondelete="SET NULL"),
        nullable=True,
    ))


def downgrade() -> None:
    op.drop_column("filaments", "warehouse_product_id")
    op.drop_column("filaments", "hex_color")
