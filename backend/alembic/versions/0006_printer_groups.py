"""printer_groups table and group_id on printers

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-10
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "printer_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_printer_groups_sort_order", "printer_groups", ["sort_order"])

    op.add_column(
        "printers",
        sa.Column(
            "group_id",
            sa.Integer(),
            sa.ForeignKey("printer_groups.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_printers_group_id", "printers", ["group_id"])


def downgrade() -> None:
    op.drop_index("ix_printers_group_id", table_name="printers")
    op.drop_column("printers", "group_id")
    op.drop_index("ix_printer_groups_sort_order", table_name="printer_groups")
    op.drop_table("printer_groups")
