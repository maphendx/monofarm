"""Add filament_meta JSONB to gcode_files

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-11
"""
from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gcode_files", sa.Column("filament_meta", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("gcode_files", "filament_meta")
