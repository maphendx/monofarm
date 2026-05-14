"""printer sort_order column

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-10

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "printers",
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_printers_sort_order", "printers", ["sort_order"])


def downgrade() -> None:
    op.drop_index("ix_printers_sort_order", table_name="printers")
    op.drop_column("printers", "sort_order")
