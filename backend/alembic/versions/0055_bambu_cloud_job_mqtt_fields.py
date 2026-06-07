"""bambu cloud job mqtt runtime fields

Revision ID: 0055
Revises: 0054
Create Date: 2026-06-07
"""
from alembic import op
import sqlalchemy as sa

revision = "0055"
down_revision = "0054"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bambu_cloud_jobs", sa.Column("progress_pct", sa.Integer(), nullable=True))
    op.add_column("bambu_cloud_jobs", sa.Column("eta_minutes", sa.Integer(), nullable=True))
    op.add_column("bambu_cloud_jobs", sa.Column("error_msg", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("bambu_cloud_jobs", "error_msg")
    op.drop_column("bambu_cloud_jobs", "eta_minutes")
    op.drop_column("bambu_cloud_jobs", "progress_pct")
