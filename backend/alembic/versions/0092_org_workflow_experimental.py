"""Experimental workflow-editor access flag per organization.

Revision ID: 0092
Revises: 0091
"""
from alembic import op
import sqlalchemy as sa

revision = "0092"
down_revision = "0091"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # New orgs start with the experimental editor disabled. Organizations that
    # already built automations keep full access — hiding the editor must not
    # cut off the people who use it.
    op.add_column(
        "organizations",
        sa.Column("workflows_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.execute(
        "UPDATE organizations SET workflows_enabled = true "
        "WHERE id IN (SELECT DISTINCT organization_id FROM workflows)"
    )


def downgrade() -> None:
    op.drop_column("organizations", "workflows_enabled")
