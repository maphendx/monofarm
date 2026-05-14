"""Add filament_colors table

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-10
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "filament_colors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("hex_color", sa.String(7), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_filament_colors_sort_order", "filament_colors", ["sort_order"])


def downgrade() -> None:
    op.drop_index("ix_filament_colors_sort_order", table_name="filament_colors")
    op.drop_table("filament_colors")
