"""add min_stock, desired_stock, box_limit to products

Revision ID: 0030
Revises: 0029
Create Date: 2026-05-27

"""
from alembic import op
import sqlalchemy as sa

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("wh_products", sa.Column("min_stock",     sa.Integer(), nullable=True))
    op.add_column("wh_products", sa.Column("desired_stock", sa.Integer(), nullable=True))
    op.add_column("wh_products", sa.Column("box_limit",     sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("wh_products", "box_limit")
    op.drop_column("wh_products", "desired_stock")
    op.drop_column("wh_products", "min_stock")
