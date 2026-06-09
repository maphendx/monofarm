"""printers: firmware_version, power_watts

Revision ID: 0059
Revises: 0058
Create Date: 2026-06-09
"""
from alembic import op
import sqlalchemy as sa

revision = "0059"
down_revision = "0058"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printers", sa.Column("firmware_version", sa.String(32), nullable=True))
    op.add_column("printers", sa.Column("power_watts", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "power_watts")
    op.drop_column("printers", "firmware_version")
