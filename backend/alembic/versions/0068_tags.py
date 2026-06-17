"""Tags system — printers, gcode_files, print_tasks.

Revision ID: 0068
Revises: 0067
Create Date: 2026-06-17
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0068"
down_revision = "0067"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── tags ──────────────────────────────────────────────────────────────────
    op.create_table(
        "tags",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "organization_id",
            sa.Integer,
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # "nozzle" | "material" | "custom"
        sa.Column("kind", sa.String(20), nullable=False),
        # For kind=custom: the label text
        sa.Column("label", sa.String(80), nullable=True),
        # For kind=custom: background color in CSS hex (e.g. '#e74c3c')
        sa.Column("color", sa.String(9), nullable=True),
        # For kind=nozzle: nozzle diameter float stored as str ("0.4")
        # For kind=material: JSON {type, color, color_name}
        # For kind=custom: null
        sa.Column("meta", JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_tags_org_kind", "tags", ["organization_id", "kind"])

    # ── printer_tags (M2M) ────────────────────────────────────────────────────
    op.create_table(
        "printer_tags",
        sa.Column("printer_id", sa.Integer, sa.ForeignKey("printers.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.Integer, sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    )

    # ── gcode_file_tags (M2M) ─────────────────────────────────────────────────
    op.create_table(
        "gcode_file_tags",
        sa.Column("gcode_file_id", sa.Integer, sa.ForeignKey("gcode_files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.Integer, sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    )

    # ── print_task_tags (M2M) ─────────────────────────────────────────────────
    op.create_table(
        "print_task_tags",
        sa.Column(
            "print_task_id", sa.Integer, sa.ForeignKey("print_tasks.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("tag_id", sa.Integer, sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    )


def downgrade() -> None:
    op.drop_table("print_task_tags")
    op.drop_table("gcode_file_tags")
    op.drop_table("printer_tags")
    op.drop_index("ix_tags_org_kind", table_name="tags")
    op.drop_table("tags")
