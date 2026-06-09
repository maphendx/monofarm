"""printers: build_x, build_y, build_z (mm)

Revision ID: 0060
Revises: 0059
Create Date: 2026-06-09
"""
from alembic import op
import sqlalchemy as sa

revision = "0060"
down_revision = "0059"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("printers", sa.Column("build_x", sa.Integer(), nullable=True))
    op.add_column("printers", sa.Column("build_y", sa.Integer(), nullable=True))
    op.add_column("printers", sa.Column("build_z", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "build_z")
    op.drop_column("printers", "build_y")
    op.drop_column("printers", "build_x")
