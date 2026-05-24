"""cost tracking: filament cost_per_kg, task production outcome

Revision ID: 0022
Revises: 0021
Create Date: 2026-05-24
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: Union[str, None] = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("filaments", sa.Column("cost_per_kg", sa.Integer, nullable=True))

    op.add_column("print_tasks", sa.Column("pieces_ok", sa.Integer, nullable=True))
    op.add_column("print_tasks", sa.Column("pieces_defective", sa.Integer, nullable=True))
    op.add_column("print_tasks", sa.Column("defect_reason", sa.String(255), nullable=True))
    op.add_column("print_tasks", sa.Column("material_cost_uah", sa.Float, nullable=True))


def downgrade() -> None:
    op.drop_column("print_tasks", "material_cost_uah")
    op.drop_column("print_tasks", "defect_reason")
    op.drop_column("print_tasks", "pieces_defective")
    op.drop_column("print_tasks", "pieces_ok")
    op.drop_column("filaments", "cost_per_kg")
