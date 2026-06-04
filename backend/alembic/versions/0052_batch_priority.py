"""batch priority

Revision ID: 0052
Revises: 0051
Create Date: 2026-06-04
"""
from alembic import op
import sqlalchemy as sa

revision = "0052"
down_revision = "0051"
branch_labels = None
depends_on = None


batch_priority = sa.Enum("low", "normal", "high", "urgent", name="batchpriority")


def upgrade() -> None:
    batch_priority.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "wh_batches",
        sa.Column(
            "priority",
            batch_priority,
            nullable=False,
            server_default="normal",
        ),
    )
    op.create_index("ix_wh_batches_priority", "wh_batches", ["priority"])


def downgrade() -> None:
    op.drop_index("ix_wh_batches_priority", table_name="wh_batches")
    op.drop_column("wh_batches", "priority")
    batch_priority.drop(op.get_bind(), checkfirst=True)
