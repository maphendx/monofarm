"""Store operator production reports on individual print runs.

Revision ID: 0087
Revises: 0086
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0087"
down_revision = "0086"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("print_history", sa.Column("output_report", postgresql.JSONB(), nullable=True))
    op.add_column("printers", sa.Column("last_cleared_history_id", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "last_cleared_history_id")
    op.drop_column("print_history", "output_report")
