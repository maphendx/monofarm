"""Ready-made notification rules (print failed / filament low) per organization.

Revision ID: 0091
Revises: 0090
"""
from alembic import op
import sqlalchemy as sa

revision = "0091"
down_revision = "0090"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Defaults keep current behavior: print-failure alerts were always on.
    op.add_column(
        "organizations",
        sa.Column("notify_print_failed", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.add_column(
        "organizations",
        sa.Column("notify_filament_low", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )


def downgrade() -> None:
    op.drop_column("organizations", "notify_filament_low")
    op.drop_column("organizations", "notify_print_failed")
