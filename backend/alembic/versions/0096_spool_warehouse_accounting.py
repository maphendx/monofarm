"""Bind physical spools to their warehouse and receipt; freeze run material identity."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0096"
down_revision = "0095"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("filaments", sa.Column("warehouse_id", sa.Integer(), sa.ForeignKey("wh_warehouses.id", ondelete="RESTRICT")))
    op.add_column("filaments", sa.Column("receipt_id", sa.Integer(), sa.ForeignKey("wh_movements.id", ondelete="RESTRICT")))
    op.add_column("print_history", sa.Column("material_plan", postgresql.JSONB()))
    # Only backfill unambiguous locations. Multiple warehouses need an explicit choice.
    op.execute("""UPDATE filaments f SET warehouse_id = s.warehouse_id
        FROM (SELECT organization_id, product_id, min(warehouse_id) AS warehouse_id
              FROM wh_stock_entries WHERE quantity > 0 GROUP BY organization_id, product_id HAVING count(*) = 1) s
        WHERE f.organization_id = s.organization_id AND f.warehouse_product_id = s.product_id""")


def downgrade():
    op.drop_column("print_history", "material_plan")
    op.drop_column("filaments", "receipt_id")
    op.drop_column("filaments", "warehouse_id")
