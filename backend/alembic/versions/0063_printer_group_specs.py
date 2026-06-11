"""printer_groups: add profile spec columns (color, nozzle, build volume, materials)

Revision ID: 0063
Revises: 0062
Create Date: 2026-06-11
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0063"
down_revision = "0062"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printer_groups", sa.Column("color", sa.String(16), nullable=True))
    op.add_column("printer_groups", sa.Column("nozzle_diameter", sa.Float(), nullable=True))
    op.add_column("printer_groups", sa.Column("build_x", sa.Integer(), nullable=True))
    op.add_column("printer_groups", sa.Column("build_y", sa.Integer(), nullable=True))
    op.add_column("printer_groups", sa.Column("build_z", sa.Integer(), nullable=True))
    op.add_column("printer_groups", sa.Column(
        "supported_materials",
        postgresql.JSONB(astext_type=sa.Text()),
        nullable=True,
        server_default="[]",
    ))


def downgrade() -> None:
    op.drop_column("printer_groups", "supported_materials")
    op.drop_column("printer_groups", "build_z")
    op.drop_column("printer_groups", "build_y")
    op.drop_column("printer_groups", "build_x")
    op.drop_column("printer_groups", "nozzle_diameter")
    op.drop_column("printer_groups", "color")
