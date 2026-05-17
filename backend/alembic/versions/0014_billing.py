"""Add billing fields to organizations

Revision ID: 0014_billing
Revises: 0013_print_history
Create Date: 2026-05-17
"""
from alembic import op
import sqlalchemy as sa

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("organizations", sa.Column("plan", sa.String(20), nullable=False, server_default="free"))
    op.add_column("organizations", sa.Column("stripe_customer_id", sa.String(255), nullable=True))
    op.add_column("organizations", sa.Column("stripe_subscription_id", sa.String(255), nullable=True))
    op.add_column("organizations", sa.Column("plan_expires_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("organizations", "plan_expires_at")
    op.drop_column("organizations", "stripe_subscription_id")
    op.drop_column("organizations", "stripe_customer_id")
    op.drop_column("organizations", "plan")
