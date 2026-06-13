"""printer: add autoprint_mode + bed_clear_pending columns

Revision ID: 0064
Revises: 0063
Create Date: 2026-06-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0064"
down_revision = "0063"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "printers",
        sa.Column("autoprint_mode", sa.String(length=10), nullable=False, server_default="off"),
    )
    op.add_column(
        "printers",
        sa.Column("bed_clear_pending", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("printers", "bed_clear_pending")
    op.drop_column("printers", "autoprint_mode")
