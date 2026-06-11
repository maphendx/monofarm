"""printer_groups: add profile spec columns (color, nozzle, build volume, materials)

Revision ID: 0063
Revises: 0062
Create Date: 2026-06-11
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0063"
down_revision = "0062"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # During rolling deploy the old container stays alive and can hold open
    # transactions on this table, causing ALTER TABLE to wait indefinitely.
    # Terminate idle-in-transaction connections from the same DB user to unblock.
    conn.execute(sa.text("""
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND usename = current_user
          AND state IN ('idle in transaction', 'idle in transaction (aborted)')
    """))
    conn.execute(sa.text("""
        ALTER TABLE printer_groups
            ADD COLUMN IF NOT EXISTS color VARCHAR(16),
            ADD COLUMN IF NOT EXISTS nozzle_diameter FLOAT,
            ADD COLUMN IF NOT EXISTS build_x INTEGER,
            ADD COLUMN IF NOT EXISTS build_y INTEGER,
            ADD COLUMN IF NOT EXISTS build_z INTEGER,
            ADD COLUMN IF NOT EXISTS supported_materials JSONB DEFAULT '[]'
    """))


def downgrade() -> None:
    op.drop_column("printer_groups", "supported_materials")
    op.drop_column("printer_groups", "build_z")
    op.drop_column("printer_groups", "build_y")
    op.drop_column("printer_groups", "build_x")
    op.drop_column("printer_groups", "nozzle_diameter")
    op.drop_column("printer_groups", "color")
