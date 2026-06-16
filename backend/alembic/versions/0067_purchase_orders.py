"""purchase orders

Revision ID: 0067
Revises: 0066
Create Date: 2026-06-16
"""
from alembic import op
import sqlalchemy as sa

revision = "0067"
down_revision = "0066"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE purchaseorderstatus AS ENUM ('draft', 'received', 'cancelled');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS wh_purchase_orders (
            id              SERIAL PRIMARY KEY,
            organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            counterparty_id INTEGER REFERENCES wh_counterparties(id) ON DELETE SET NULL,
            warehouse_id    INTEGER REFERENCES wh_warehouses(id) ON DELETE SET NULL,
            status          purchaseorderstatus NOT NULL DEFAULT 'draft',
            notes           TEXT,
            received_at     TIMESTAMPTZ,
            created_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_wh_purchase_orders_organization_id ON wh_purchase_orders(organization_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_wh_purchase_orders_counterparty_id ON wh_purchase_orders(counterparty_id)")

    op.execute("""
        CREATE TABLE IF NOT EXISTS wh_purchase_order_items (
            id                SERIAL PRIMARY KEY,
            purchase_order_id INTEGER NOT NULL REFERENCES wh_purchase_orders(id) ON DELETE CASCADE,
            product_id        INTEGER NOT NULL REFERENCES wh_products(id) ON DELETE RESTRICT,
            quantity          NUMERIC(12,4) NOT NULL,
            unit_cost         NUMERIC(14,4) NOT NULL
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_wh_purchase_order_items_purchase_order_id ON wh_purchase_order_items(purchase_order_id)")


def downgrade() -> None:
    op.drop_table("wh_purchase_order_items")
    op.drop_table("wh_purchase_orders")
    op.execute("DROP TYPE purchaseorderstatus")
