"""add gcode_folders table and folder_id to gcode_files

Revision ID: 0024_gcode_folders
Revises: 426df3a62f96
Create Date: 2026-05-24
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0024_gcode_folders"
down_revision: Union[str, None] = "426df3a62f96"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "gcode_folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id",
            sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_gcode_folders_org_id", "gcode_folders", ["organization_id"])

    op.add_column(
        "gcode_files",
        sa.Column(
            "folder_id",
            sa.Integer(),
            sa.ForeignKey("gcode_folders.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_gcode_files_folder_id", "gcode_files", ["folder_id"])


def downgrade() -> None:
    op.drop_index("ix_gcode_files_folder_id", table_name="gcode_files")
    op.drop_column("gcode_files", "folder_id")
    op.drop_index("ix_gcode_folders_org_id", table_name="gcode_folders")
    op.drop_table("gcode_folders")
