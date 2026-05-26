"""bambu_lan_mode column on printers

Revision ID: 0027
Revises: 0026
Create Date: 2026-05-26
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0027"
down_revision: Union[str, None] = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "printers",
        sa.Column("bambu_lan_mode", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("printers", "bambu_lan_mode")
