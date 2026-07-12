"""Add durable bed_cleared_at flag so the "clear bed" confirmation is a pure
operator-side marker, independent of live MQTT/Moonraker telemetry.

Revision ID: 0078
Revises: 0077
"""
from alembic import op
import sqlalchemy as sa


revision = "0078"
down_revision = "0077"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printers", sa.Column("bed_cleared_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "bed_cleared_at")
