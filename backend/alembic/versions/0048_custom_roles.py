"""add custom roles

Revision ID: 0048
Revises: 0047
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0048"
down_revision = "0047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "org_custom_roles",
        sa.Column("id",              sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name",            sa.String(80), nullable=False),
        sa.Column("allowed_modules", sa.JSON(),    nullable=False, server_default="[]"),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.add_column("users",
        sa.Column("custom_role_id", sa.Integer(),
                  sa.ForeignKey("org_custom_roles.id", ondelete="SET NULL"), nullable=True, index=True))


def downgrade() -> None:
    op.drop_column("users", "custom_role_id")
    op.drop_table("org_custom_roles")
