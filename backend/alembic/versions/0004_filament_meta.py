"""filament_meta JSON on print_tasks

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("print_tasks", sa.Column("filament_meta", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("print_tasks", "filament_meta")
