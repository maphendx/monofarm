"""add barcode to product

Revision ID: 0028
Revises: 0027
Create Date: 2026-05-27

"""
from alembic import op
import sqlalchemy as sa

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("wh_products", sa.Column("barcode", sa.String(80), nullable=True))


def downgrade() -> None:
    op.drop_column("wh_products", "barcode")
