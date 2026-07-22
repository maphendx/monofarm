"""Add assigned_group_id to gcode_files — pins a file to the printer group it was sliced for

Revision ID: 0084
Revises: 0083
Create Date: 2026-07-22
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0084"
down_revision: Union[str, None] = "0083"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gcode_files", sa.Column("assigned_group_id", sa.Integer(), nullable=True))
    op.create_index(
        "ix_gcode_files_assigned_group_id", "gcode_files", ["assigned_group_id"]
    )
    op.create_foreign_key(
        "fk_gcode_files_assigned_group_id_printer_groups",
        "gcode_files",
        "printer_groups",
        ["assigned_group_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_gcode_files_assigned_group_id_printer_groups", "gcode_files", type_="foreignkey"
    )
    op.drop_index("ix_gcode_files_assigned_group_id", table_name="gcode_files")
    op.drop_column("gcode_files", "assigned_group_id")
