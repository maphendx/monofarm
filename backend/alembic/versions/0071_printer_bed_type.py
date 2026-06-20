"""add bed_type to printers

Revision ID: 0071
Revises: 0070
Create Date: 2026-06-19
"""
from alembic import op
import sqlalchemy as sa

revision = "0071"
down_revision = "0070"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "printers",
        sa.Column("bed_type", sa.String(length=40), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("printers", "bed_type")
