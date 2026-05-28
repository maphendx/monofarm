"""product images table

Revision ID: 0032
Revises: 0031
Create Date: 2026-05-28
"""
from alembic import op
import sqlalchemy as sa

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "wh_product_images",
        sa.Column("id",              sa.Integer(),     primary_key=True),
        sa.Column("product_id",      sa.Integer(),     sa.ForeignKey("wh_products.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("organization_id", sa.Integer(),     nullable=False, index=True),
        sa.Column("image_key",       sa.String(120),   nullable=False),
        sa.Column("is_primary",      sa.Boolean(),     nullable=False, server_default="false"),
        sa.Column("sort_order",      sa.Integer(),     nullable=False, server_default="0"),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade():
    op.drop_table("wh_product_images")
