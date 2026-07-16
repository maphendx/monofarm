"""agent protocol v2 device, command, and event foundation

Revision ID: 0080
Revises: 0079
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0080"
down_revision = "0079"
branch_labels = None
depends_on = None


agent_command_state = sa.Enum(
    "queued",
    "leased",
    "accepted",
    "executing",
    "delivered",
    "printer_ack",
    "terminal",
    "needs_reconcile",
    "failed",
    name="agentcommandstate",
)


def upgrade() -> None:
    op.create_table(
        "agent_devices",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("site_id", sa.String(length=64), nullable=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("public_key", sa.Text(), nullable=True),
        sa.Column("credential_hash", sa.String(length=64), nullable=True),
        sa.Column("credential_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("scopes", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("pairing_code_hash", sa.String(length=64), nullable=True),
        sa.Column("pairing_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("paired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("capabilities", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=True),
        sa.Column("build", sa.String(length=64), nullable=True),
        sa.Column("channel", sa.String(length=32), server_default="stable", nullable=False),
        sa.Column("connection_epoch", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("credential_hash"),
        sa.UniqueConstraint("pairing_code_hash"),
    )
    op.create_index("ix_agent_devices_organization_id", "agent_devices", ["organization_id"])

    op.create_table(
        "agent_commands",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("agent_device_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("printer_id", sa.Integer(), nullable=True),
        sa.Column("command_type", sa.String(length=64), nullable=False),
        sa.Column("payload_json", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("state", agent_command_state, server_default="queued", nullable=False),
        sa.Column("attempt", sa.Integer(), server_default="0", nullable=False),
        sa.Column("deadline_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_owner", sa.String(length=128), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("attempt >= 0", name="ck_agent_commands_attempt_nonnegative"),
        sa.ForeignKeyConstraint(["agent_device_id"], ["agent_devices.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["printer_id"], ["printers.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "idempotency_key", name="uq_agent_commands_org_idempotency"),
    )
    op.create_index("ix_agent_commands_agent_device_id", "agent_commands", ["agent_device_id"])
    op.create_index("ix_agent_commands_device_state", "agent_commands", ["agent_device_id", "state"])
    op.create_index("ix_agent_commands_org_created", "agent_commands", ["organization_id", "created_at"])
    op.create_index("ix_agent_commands_organization_id", "agent_commands", ["organization_id"])
    op.create_index("ix_agent_commands_printer_id", "agent_commands", ["printer_id"])

    op.create_table(
        "agent_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("agent_device_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("printer_id", sa.Integer(), nullable=True),
        sa.Column("command_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("monotonic_sequence", sa.BigInteger(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("payload_json", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("occurred_at_device", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at_cloud", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("monotonic_sequence >= 0", name="ck_agent_events_sequence_nonnegative"),
        sa.ForeignKeyConstraint(["agent_device_id"], ["agent_devices.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["command_id"], ["agent_commands.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["printer_id"], ["printers.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("agent_device_id", "monotonic_sequence", name="uq_agent_events_device_sequence"),
    )
    op.create_index("ix_agent_events_agent_device_id", "agent_events", ["agent_device_id"])
    op.create_index("ix_agent_events_command_id", "agent_events", ["command_id"])
    op.create_index("ix_agent_events_org_received", "agent_events", ["organization_id", "received_at_cloud"])
    op.create_index("ix_agent_events_organization_id", "agent_events", ["organization_id"])
    op.create_index("ix_agent_events_printer_id", "agent_events", ["printer_id"])


def downgrade() -> None:
    op.drop_table("agent_events")
    op.drop_table("agent_commands")
    op.drop_table("agent_devices")
    agent_command_state.drop(op.get_bind(), checkfirst=True)
