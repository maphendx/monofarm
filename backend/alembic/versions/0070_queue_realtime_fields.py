"""add started_at/completed_at to print_tasks for queue tracking

Revision ID: 0070
Revises: 0069
Create Date: 2026-06-18
"""
from alembic import op
import sqlalchemy as sa

revision = "0070"
down_revision = "0069"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "print_tasks",
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "print_tasks",
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("print_tasks", "completed_at")
    op.drop_column("print_tasks", "started_at")
