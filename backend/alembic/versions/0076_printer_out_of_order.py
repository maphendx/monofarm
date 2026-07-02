"""printer is_out_of_order flag

Revision ID: 0076
Revises: 0075
Create Date: 2026-07-02
"""
import sqlalchemy as sa
from alembic import op

revision = "0076"
down_revision = "0075"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "printers",
        sa.Column("is_out_of_order", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("printers", "is_out_of_order")
