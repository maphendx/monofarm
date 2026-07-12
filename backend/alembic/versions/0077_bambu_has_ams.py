"""Add operator-selected AMS mode to Bambu printers.

Revision ID: 0077
Revises: 0076
"""
from alembic import op
import sqlalchemy as sa


revision = "0077"
down_revision = "0076"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printers", sa.Column("bambu_has_ams", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "bambu_has_ams")
