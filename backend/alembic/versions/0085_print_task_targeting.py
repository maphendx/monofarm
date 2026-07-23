"""Add assigned_group_id + target_printer_ids to print_tasks — queue-item printer/group targeting

Revision ID: 0085
Revises: 0084
Create Date: 2026-07-23
"""
from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0085"
down_revision: Union[str, None] = "0084"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("print_tasks", sa.Column("assigned_group_id", sa.Integer(), nullable=True))
    op.create_index(
        "ix_print_tasks_assigned_group_id", "print_tasks", ["assigned_group_id"]
    )
    op.create_foreign_key(
        "fk_print_tasks_assigned_group_id_printer_groups",
        "print_tasks",
        "printer_groups",
        ["assigned_group_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "print_tasks", sa.Column("target_printer_ids", postgresql.JSONB(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("print_tasks", "target_printer_ids")
    op.drop_constraint(
        "fk_print_tasks_assigned_group_id_printer_groups", "print_tasks", type_="foreignkey"
    )
    op.drop_index("ix_print_tasks_assigned_group_id", table_name="print_tasks")
    op.drop_column("print_tasks", "assigned_group_id")
