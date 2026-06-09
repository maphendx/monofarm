"""print_history: printer_kind, slots_used, material_cost

Revision ID: 0057
Revises: 0056
Create Date: 2026-06-09
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0057"
down_revision = "0056"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("print_history", sa.Column("printer_kind", sa.String(32), nullable=True))
    op.add_column("print_history", sa.Column("slots_used", JSONB, nullable=True))
    op.add_column("print_history", sa.Column("material_cost", sa.Numeric(10, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("print_history", "material_cost")
    op.drop_column("print_history", "slots_used")
    op.drop_column("print_history", "printer_kind")
