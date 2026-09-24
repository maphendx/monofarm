"""Persist Telegram delivery claims and filament threshold episodes.

Revision ID: 0093
Revises: 0092
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0093"
down_revision = "0092"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("filaments", sa.Column("low_alert_active", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("filaments", sa.Column("low_alert_episode", sa.Integer(), nullable=False, server_default="0"))
    # Existing low stock is not a fresh crossing; don't alert on migration.
    op.execute("UPDATE filaments SET low_alert_active = true WHERE grams_remaining <= min_grams")
    op.create_table(
        "telegram_notifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_key", sa.String(80), nullable=False),
        sa.Column("rule", sa.String(40), nullable=False),
        sa.Column("payload", JSONB(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("sent_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("attempted_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("organization_id", "event_key", name="uq_telegram_notification_event"),
    )
    op.create_index("ix_telegram_notifications_organization_id", "telegram_notifications", ["organization_id"])
    op.create_index("ix_telegram_notifications_status", "telegram_notifications", ["status"])
    # Preserve existing workflow notification ownership. Conservative detection
    # also catches conditional Telegram paths; no workflow data is modified.
    for event, column in (("print.failed", "notify_print_failed"), ("filament.low", "notify_filament_low")):
        op.execute(sa.text(f"""
            UPDATE organizations SET {column} = false WHERE id IN (
                SELECT organization_id FROM workflows w WHERE enabled
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.graph->'nodes') n
                    WHERE n->>'type' = 'action.notify_telegram')
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.graph->'nodes') n
                    WHERE n->>'type' = 'trigger.event' AND n->'config'->>'event_type' = :event)
            )
        """).bindparams(event=event))


def downgrade() -> None:
    op.drop_table("telegram_notifications")
    op.drop_column("filaments", "low_alert_episode")
    op.drop_column("filaments", "low_alert_active")
