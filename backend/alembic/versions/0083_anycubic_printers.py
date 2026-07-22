"""Add Anycubic Kobra local-LAN printer support: kind enum value + anycubic_* columns

Revision ID: 0083
Revises: 0082
Create Date: 2026-07-22
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0083"
down_revision: Union[str, None] = "0082"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ALTER TYPE ADD VALUE cannot be referenced in the same transaction on older PG;
    # we only add the label here and reference it in application code (see 0011, 0040).
    op.execute("ALTER TYPE printerkind ADD VALUE IF NOT EXISTS 'anycubic'")

    op.add_column("printers", sa.Column("anycubic_dev_ip", sa.String(45), nullable=True))
    op.add_column("printers", sa.Column("anycubic_dev_id", sa.String(64), nullable=True))
    op.add_column("printers", sa.Column("anycubic_model_id", sa.String(16), nullable=True))
    op.add_column("printers", sa.Column("anycubic_model_name", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("printers", "anycubic_model_name")
    op.drop_column("printers", "anycubic_model_id")
    op.drop_column("printers", "anycubic_dev_id")
    op.drop_column("printers", "anycubic_dev_ip")
    # Postgres has no DROP VALUE for enums; the extra 'anycubic' label is left in place (harmless).
