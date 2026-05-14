"""Add Bambu Lab printer support: kind enum value + bambu_* columns

Revision ID: 0011
Revises: 0010
Create Date: 2026-05-11
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE printerkind ADD VALUE IF NOT EXISTS 'bambu'")

    op.add_column("printers", sa.Column("bambu_dev_id", sa.String(64), nullable=True))
    op.add_column("printers", sa.Column("bambu_access_code", sa.String(16), nullable=True))
    op.add_column("printers", sa.Column("bambu_dev_ip", sa.String(45), nullable=True))
    op.add_column("printers", sa.Column("bambu_model", sa.String(32), nullable=True))

    op.create_index("ix_printers_bambu_dev_id", "printers", ["bambu_dev_id"])


def downgrade() -> None:
    op.drop_index("ix_printers_bambu_dev_id", table_name="printers")
    op.drop_column("printers", "bambu_model")
    op.drop_column("printers", "bambu_dev_ip")
    op.drop_column("printers", "bambu_access_code")
    op.drop_column("printers", "bambu_dev_id")
