"""backfill assign_cell movements: ADJUSTMENT → PURCHASE_IN where qty > 0

Revision ID: 0043
Revises: 0042
Create Date: 2026-06-01
"""
from alembic import op

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'warehouse_movements'
            ) THEN
                UPDATE warehouse_movements
                SET type = 'PURCHASE_IN'
                WHERE type = 'ADJUSTMENT'
                  AND reason LIKE 'Призначення в комірку%%'
                  AND quantity > 0;
            END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'warehouse_movements'
            ) THEN
                UPDATE warehouse_movements
                SET type = 'ADJUSTMENT'
                WHERE type = 'PURCHASE_IN'
                  AND reason LIKE 'Призначення в комірку%%'
                  AND quantity > 0;
            END IF;
        END $$;
    """)
