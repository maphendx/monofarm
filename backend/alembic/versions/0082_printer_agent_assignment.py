"""assign printers to agent devices

Revision ID: 0082
Revises: 0081
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0082"
down_revision = "0081"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "printers",
        sa.Column("agent_device_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_printers_agent_device_id",
        "printers",
        "agent_devices",
        ["agent_device_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_printers_agent_device_id", "printers", ["agent_device_id"])


def downgrade() -> None:
    op.drop_index("ix_printers_agent_device_id", table_name="printers")
    op.drop_constraint("fk_printers_agent_device_id", "printers", type_="foreignkey")
    op.drop_column("printers", "agent_device_id")
