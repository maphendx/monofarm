"""plan_entries: scheduling fields (start_time, schedule_mode, window, priority, blocked_reason)

Revision ID: 0061
Revises: 0060
Create Date: 2026-06-10
"""
import sqlalchemy as sa
from alembic import op

revision = "0061"
down_revision = "0060"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plan_entries", sa.Column("start_time", sa.Time(), nullable=True))
    op.add_column(
        "plan_entries",
        sa.Column("schedule_mode", sa.String(20), nullable=False, server_default="asap"),
    )
    op.add_column(
        "plan_entries",
        sa.Column("window_start_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "plan_entries",
        sa.Column("window_end_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "plan_entries",
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "plan_entries",
        sa.Column("blocked_reason", sa.String(100), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("plan_entries", "blocked_reason")
    op.drop_column("plan_entries", "priority")
    op.drop_column("plan_entries", "window_end_at")
    op.drop_column("plan_entries", "window_start_at")
    op.drop_column("plan_entries", "schedule_mode")
    op.drop_column("plan_entries", "start_time")
