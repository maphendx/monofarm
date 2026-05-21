"""Product categories — standalone reference table

Revision ID: 0020
Revises: 0019
Create Date: 2026-05-22
"""
import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wh_product_categories",
        sa.Column("id",              sa.Integer(),     primary_key=True),
        sa.Column("organization_id", sa.Integer(),     sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name",            sa.String(120),   nullable=False),
        sa.Column("color",           sa.String(7),     nullable=True),   # hex e.g. #e5e7eb
        sa.Column("sort_order",      sa.Integer(),     default=0, nullable=False),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("organization_id", "name", name="uq_wh_cat_org_name"),
    )


def downgrade() -> None:
    op.drop_table("wh_product_categories")
