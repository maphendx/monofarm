"""add horoshop integration

Revision ID: 0049
Revises: 0048
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE ordersource ADD VALUE IF NOT EXISTS 'horoshop'")

    op.add_column("organizations", sa.Column("horoshop_domain", sa.String(255), nullable=False, server_default=""))
    op.add_column("organizations", sa.Column("horoshop_login", sa.String(255), nullable=False, server_default=""))
    op.add_column("organizations", sa.Column("horoshop_password", sa.String(512), nullable=False, server_default=""))
    op.add_column("organizations", sa.Column("horoshop_webhook_secret", sa.String(255), nullable=False, server_default=""))
    op.add_column("organizations", sa.Column("horoshop_hook_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"))
    op.add_column("organizations", sa.Column("horoshop_last_sync_at", sa.DateTime(timezone=True), nullable=True))

    op.add_column("wh_orders", sa.Column("external_id", sa.String(120), nullable=True))
    op.add_column("wh_orders", sa.Column("external_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.create_index("ix_wh_orders_external_id", "wh_orders", ["external_id"])
    op.create_index(
        "uq_wh_orders_org_source_external",
        "wh_orders",
        ["organization_id", "source", "external_id"],
        unique=True,
        postgresql_where=sa.text("external_id IS NOT NULL"),
    )

    op.create_table(
        "horoshop_sync_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_type", sa.String(80), nullable=False),
        sa.Column("external_order_id", sa.String(120), nullable=True),
        sa.Column("status", sa.String(24), nullable=False, server_default="pending"),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_horoshop_sync_events_org", "horoshop_sync_events", ["organization_id"])
    op.create_index("ix_horoshop_sync_events_external_order", "horoshop_sync_events", ["external_order_id"])
    op.create_index("ix_horoshop_sync_events_org_created", "horoshop_sync_events", ["organization_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_horoshop_sync_events_org_created", table_name="horoshop_sync_events")
    op.drop_index("ix_horoshop_sync_events_external_order", table_name="horoshop_sync_events")
    op.drop_index("ix_horoshop_sync_events_org", table_name="horoshop_sync_events")
    op.drop_table("horoshop_sync_events")
    op.drop_index("uq_wh_orders_org_source_external", table_name="wh_orders")
    op.drop_index("ix_wh_orders_external_id", table_name="wh_orders")
    op.drop_column("wh_orders", "external_payload")
    op.drop_column("wh_orders", "external_id")

    op.drop_column("organizations", "horoshop_last_sync_at")
    op.drop_column("organizations", "horoshop_hook_ids")
    op.drop_column("organizations", "horoshop_webhook_secret")
    op.drop_column("organizations", "horoshop_password")
    op.drop_column("organizations", "horoshop_login")
    op.drop_column("organizations", "horoshop_domain")
    # PostgreSQL enum values cannot be removed safely without rebuilding the type.
