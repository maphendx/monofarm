"""global admin foundation

Revision ID: 0051
Revises: 0050
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0051"
down_revision = "0050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("users", "organization_id", existing_type=sa.Integer(), nullable=True)
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        "ck_users_non_admin_requires_org",
        "users",
        "role = 'admin' OR organization_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_constraint("ck_users_non_admin_requires_org", "users", type_="check")
    op.drop_column("users", "last_login_at")
    op.alter_column("users", "organization_id", existing_type=sa.Integer(), nullable=False)
