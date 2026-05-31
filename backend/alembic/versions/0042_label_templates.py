"""label templates

Revision ID: 0042
Revises: 0041
Create Date: 2026-05-31
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wh_label_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("item_type", sa.String(20), nullable=False, server_default="universal"),
        sa.Column("width_mm", sa.Numeric(8, 2), nullable=False, server_default="57"),
        sa.Column("height_mm", sa.Numeric(8, 2), nullable=False, server_default="32"),
        sa.Column("elements", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_wh_label_templates_org", "wh_label_templates", ["organization_id"])


def downgrade() -> None:
    op.drop_index("ix_wh_label_templates_org", "wh_label_templates")
    op.drop_table("wh_label_templates")
