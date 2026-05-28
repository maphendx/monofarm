"""add image_key to products

Revision ID: 0031
Revises: 0030
Create Date: 2026-05-28

"""
from alembic import op
import sqlalchemy as sa

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("wh_products", sa.Column("image_key", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("wh_products", "image_key")
