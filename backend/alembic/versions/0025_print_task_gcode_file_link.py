"""link print_tasks to gcode_files for thumbnails

Revision ID: 0025_print_task_gcode_file_link
Revises: 0024_gcode_folders
Create Date: 2026-05-24
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0025_print_task_gcode_file_link"
down_revision: Union[str, None] = "0024_gcode_folders"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "print_tasks",
        sa.Column("gcode_file_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_print_tasks_gcode_file_id",
        "print_tasks",
        "gcode_files",
        ["gcode_file_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_print_tasks_gcode_file_id",
        "print_tasks",
        ["organization_id", "gcode_file_id"],
    )
    # Backfill: link tasks to files with matching original_name in same org
    op.execute(
        """
        UPDATE print_tasks pt
        SET gcode_file_id = (
            SELECT gf.id
            FROM gcode_files gf
            WHERE gf.original_name = pt.file_name
              AND gf.organization_id = pt.organization_id
            ORDER BY gf.id DESC
            LIMIT 1
        )
        WHERE pt.file_name IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_print_tasks_gcode_file_id", table_name="print_tasks")
    op.drop_constraint(
        "fk_print_tasks_gcode_file_id", "print_tasks", type_="foreignkey"
    )
    op.drop_column("print_tasks", "gcode_file_id")
