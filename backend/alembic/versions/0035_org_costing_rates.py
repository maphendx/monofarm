"""org electricity and labor rates

Revision ID: 0035
Revises: 0034
Create Date: 2026-05-28
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0035"
down_revision: Union[str, None] = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("organizations", sa.Column(
        "electricity_rate", sa.Numeric(8, 4), nullable=False, server_default="4.5",
    ))
    op.add_column("organizations", sa.Column(
        "labor_rate", sa.Numeric(8, 4), nullable=False, server_default="150",
    ))


def downgrade() -> None:
    op.drop_column("organizations", "labor_rate")
    op.drop_column("organizations", "electricity_rate")
