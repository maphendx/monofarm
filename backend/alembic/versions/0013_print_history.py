"""print history

Revision ID: 0013
Revises: 0012
Create Date: 2026-05-16
"""
from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "print_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("printer_id", sa.Integer(), sa.ForeignKey("printers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("printer_name", sa.String(255), nullable=False),
        sa.Column("file_name", sa.String(512), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_minutes", sa.Integer(), nullable=True),
        sa.Column("result", sa.String(32), nullable=False, server_default="in_progress"),
        sa.Column("filament_g", sa.Float(), nullable=True),
    )
    op.create_index("ix_print_history_org_started", "print_history", ["organization_id", "started_at"])


def downgrade() -> None:
    op.drop_index("ix_print_history_org_started")
    op.drop_table("print_history")
