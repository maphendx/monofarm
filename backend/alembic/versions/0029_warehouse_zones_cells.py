"""add warehouse zones and cells

Revision ID: 0029
Revises: 0028
Create Date: 2026-05-27

"""
from alembic import op
import sqlalchemy as sa

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wh_zones",
        sa.Column("id",              sa.Integer(),     primary_key=True),
        sa.Column("organization_id", sa.Integer(),     sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("warehouse_id",    sa.Integer(),     sa.ForeignKey("wh_warehouses.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name",            sa.String(120),   nullable=False),
        sa.Column("rows",            sa.Integer(),     nullable=False, server_default="5"),
        sa.Column("cols",            sa.Integer(),     nullable=False, server_default="5"),
        sa.Column("sort_order",      sa.Integer(),     nullable=False, server_default="0"),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "wh_cells",
        sa.Column("id",      sa.Integer(),    primary_key=True),
        sa.Column("zone_id", sa.Integer(),    sa.ForeignKey("wh_zones.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("code",    sa.String(20),   nullable=False),
        sa.Column("notes",   sa.String(500),  nullable=True),
    )
    op.create_table(
        "wh_cell_stock",
        sa.Column("id",         sa.Integer(),              primary_key=True),
        sa.Column("cell_id",    sa.Integer(),              sa.ForeignKey("wh_cells.id",    ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("product_id", sa.Integer(),              sa.ForeignKey("wh_products.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("quantity",   sa.Numeric(12, 4),         nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("wh_cell_stock")
    op.drop_table("wh_cells")
    op.drop_table("wh_zones")
