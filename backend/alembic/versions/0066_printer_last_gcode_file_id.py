"""printer last_gcode_file_id for reprint

Revision ID: 0066
Revises: 0065
Create Date: 2026-06-15
"""
from alembic import op
import sqlalchemy as sa

revision = "0066"
down_revision = "0065"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printers", sa.Column("last_gcode_file_id", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "last_gcode_file_id")
