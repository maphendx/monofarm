"""filament sku, log table, task consumptions

Revision ID: 0021
Revises: 426df3a62f96
Create Date: 2026-05-24
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: Union[str, None] = "426df3a62f96"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("filaments", sa.Column("sku", sa.String(32), nullable=True))
    op.create_index("ix_filaments_sku", "filaments", ["sku"])

    op.create_table(
        "filament_log",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("organization_id", sa.Integer, sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("filament_id", sa.Integer, sa.ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("delta_grams", sa.Integer, nullable=False),
        sa.Column("grams_after", sa.Integer, nullable=False),
        sa.Column("reason", sa.Text, nullable=True),
        sa.Column("task_id", sa.Integer, sa.ForeignKey("print_tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.add_column("print_tasks", sa.Column("filament_consumptions", sa.dialects.postgresql.JSONB, nullable=True))

    # backfill SKU for existing spools
    op.execute("""
        UPDATE filaments
        SET sku = 'FL' || LPAD(organization_id::text, 4, '0') || LPAD(id::text, 5, '0')
        WHERE sku IS NULL
    """)


def downgrade() -> None:
    op.drop_column("print_tasks", "filament_consumptions")
    op.drop_table("filament_log")
    op.drop_index("ix_filaments_sku", "filaments")
    op.drop_column("filaments", "sku")
