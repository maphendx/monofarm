"""add assembly sessions and batch assigned_to

Revision ID: 0047
Revises: 0046
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("wh_batches",
        sa.Column("assigned_to_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))

    op.create_table(
        "wh_assembly_sessions",
        sa.Column("id",              sa.Integer(),  primary_key=True),
        sa.Column("organization_id", sa.Integer(),  sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("batch_id",        sa.Integer(),  sa.ForeignKey("wh_batches.id",    ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("worker_id",       sa.Integer(),  sa.ForeignKey("users.id",          ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("started_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("closed_at",       sa.DateTime(timezone=True), nullable=True),
        sa.Column("units_good",      sa.Integer(),  nullable=False, server_default="0"),
        sa.Column("units_defective", sa.Integer(),  nullable=False, server_default="0"),
        sa.Column("notes",           sa.Text(),     nullable=True),
    )


def downgrade() -> None:
    op.drop_table("wh_assembly_sessions")
    op.drop_column("wh_batches", "assigned_to_id")
