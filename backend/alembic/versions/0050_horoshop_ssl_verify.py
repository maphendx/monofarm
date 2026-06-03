"""add horoshop ssl verification setting

Revision ID: 0050
Revises: 0049
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0050"
down_revision = "0049"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "organizations",
        sa.Column("horoshop_verify_ssl", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )


def downgrade() -> None:
    op.drop_column("organizations", "horoshop_verify_ssl")
