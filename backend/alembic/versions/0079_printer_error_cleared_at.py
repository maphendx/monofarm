"""Add durable error_cleared_at flag so "Скинути помилку" is a pure
operator-side marker, independent of live MQTT/Moonraker telemetry.

Revision ID: 0079
Revises: 0078
"""
from alembic import op
import sqlalchemy as sa


revision = "0079"
down_revision = "0078"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printers", sa.Column("error_cleared_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "error_cleared_at")
