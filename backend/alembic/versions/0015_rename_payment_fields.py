"""Rename stripe_* columns to payment_* (switching to LemonSqueezy)

Revision ID: 0015
Revises: 0014
Create Date: 2026-05-17
"""
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("organizations", "stripe_customer_id", new_column_name="payment_customer_id")
    op.alter_column("organizations", "stripe_subscription_id", new_column_name="payment_subscription_id")


def downgrade() -> None:
    op.alter_column("organizations", "payment_customer_id", new_column_name="stripe_customer_id")
    op.alter_column("organizations", "payment_subscription_id", new_column_name="stripe_subscription_id")
