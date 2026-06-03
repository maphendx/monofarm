"""add allowed_modules to users

Revision ID: 0046
Revises: 0045
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0046"
down_revision = "0045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("allowed_modules", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "allowed_modules")
