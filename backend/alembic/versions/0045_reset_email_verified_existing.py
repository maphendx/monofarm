"""reset email_verified_at for all existing users

Revision ID: 0045
Revises: 0044
Create Date: 2026-06-01
"""
from alembic import op

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE users SET email_verified_at = NULL")


def downgrade() -> None:
    op.execute("UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL")
