"""printer_slots: unit_index, is_external — universal multi-kind support

Revision ID: 0058
Revises: 0057
Create Date: 2026-06-09
"""
from alembic import op
import sqlalchemy as sa

revision = "0058"
down_revision = "0057"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printer_slots", sa.Column("unit_index", sa.Integer(), nullable=True))
    op.add_column(
        "printer_slots",
        sa.Column("is_external", sa.Boolean(), nullable=False, server_default="false"),
    )
    # Backfill: slot_index=254 rows (if any from Bambu backfill) → is_external=True
    op.execute(
        "UPDATE printer_slots SET is_external = true WHERE slot_index = 254"
    )


def downgrade() -> None:
    op.drop_column("printer_slots", "is_external")
    op.drop_column("printer_slots", "unit_index")
