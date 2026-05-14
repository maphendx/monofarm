"""Add gcode_files table for central file storage

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-10
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "gcode_files",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("stored_name", sa.String(80), nullable=False, unique=True),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("notes", sa.String(500), nullable=True),
        sa.Column(
            "uploaded_by_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_gcode_files_uploaded_at", "gcode_files", ["uploaded_at"])


def downgrade() -> None:
    op.drop_index("ix_gcode_files_uploaded_at", table_name="gcode_files")
    op.drop_table("gcode_files")
