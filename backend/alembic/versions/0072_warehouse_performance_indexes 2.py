"""warehouse performance indexes

Revision ID: 0072
Revises: 0071
Create Date: 2026-06-24
"""
from typing import Union

from alembic import op

revision: str = "0072"
down_revision: Union[str, None] = "0071"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_stock_entries_org_product_warehouse "
        "ON wh_stock_entries (organization_id, product_id, warehouse_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_cell_stock_cell_product "
        "ON wh_cell_stock (cell_id, product_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_zones_org_warehouse_sort "
        "ON wh_zones (organization_id, warehouse_id, sort_order, id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_orders_org_created "
        "ON wh_orders (organization_id, created_at DESC, id DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_batches_org_created "
        "ON wh_batches (organization_id, created_at DESC, id DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_cash_tx_org_date_id "
        "ON wh_cash_transactions (organization_id, transaction_date DESC, id DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_movements_org_type_created "
        "ON wh_movements (organization_id, type, created_at DESC, id DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_movements_org_product_created "
        "ON wh_movements (organization_id, product_id, created_at DESC, id DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_movements_org_batch_created "
        "ON wh_movements (organization_id, batch_id, created_at DESC, id DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_wh_movements_org_order_created "
        "ON wh_movements (organization_id, order_id, created_at DESC, id DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_wh_movements_org_order_created")
    op.execute("DROP INDEX IF EXISTS ix_wh_movements_org_batch_created")
    op.execute("DROP INDEX IF EXISTS ix_wh_movements_org_product_created")
    op.execute("DROP INDEX IF EXISTS ix_wh_movements_org_type_created")
    op.execute("DROP INDEX IF EXISTS ix_wh_cash_tx_org_date_id")
    op.execute("DROP INDEX IF EXISTS ix_wh_batches_org_created")
    op.execute("DROP INDEX IF EXISTS ix_wh_orders_org_created")
    op.execute("DROP INDEX IF EXISTS ix_wh_zones_org_warehouse_sort")
    op.execute("DROP INDEX IF EXISTS ix_wh_cell_stock_cell_product")
    op.execute("DROP INDEX IF EXISTS ix_wh_stock_entries_org_product_warehouse")
