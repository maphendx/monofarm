"""printer: add nozzle_diameter column

Revision ID: 0062
Revises: 0061
Create Date: 2026-06-11
"""
import sqlalchemy as sa
from alembic import op

revision = "0062"
down_revision = "0061"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printers", sa.Column("nozzle_diameter", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "nozzle_diameter")
