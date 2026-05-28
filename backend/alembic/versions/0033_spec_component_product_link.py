"""spec component product link

Revision ID: 0033
Revises: 0032
Create Date: 2026-05-28
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: Union[str, None] = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("wh_spec_components", sa.Column("product_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_wh_spec_components_product_id",
        "wh_spec_components", "wh_products",
        ["product_id"], ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_wh_spec_components_product_id", "wh_spec_components", ["product_id"])


def downgrade() -> None:
    op.drop_index("ix_wh_spec_components_product_id", table_name="wh_spec_components")
    op.drop_constraint("fk_wh_spec_components_product_id", "wh_spec_components", type_="foreignkey")
    op.drop_column("wh_spec_components", "product_id")
