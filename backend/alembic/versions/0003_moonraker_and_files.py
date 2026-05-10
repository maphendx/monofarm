"""moonraker_url on printers; file_name/file_size on print_tasks

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("printers", sa.Column("moonraker_url", sa.String(length=500), nullable=True))
    op.add_column("print_tasks", sa.Column("file_name", sa.String(length=255), nullable=True))
    op.add_column("print_tasks", sa.Column("file_size", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("print_tasks", "file_size")
    op.drop_column("print_tasks", "file_name")
    op.drop_column("printers", "moonraker_url")
