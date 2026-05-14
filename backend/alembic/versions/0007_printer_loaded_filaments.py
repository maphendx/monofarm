"""Add loaded_filaments JSONB column to printers

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-10
"""
from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "printers",
        sa.Column("loaded_filaments", JSONB, nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("printers", "loaded_filaments")
