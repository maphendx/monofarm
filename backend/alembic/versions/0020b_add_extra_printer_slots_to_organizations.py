"""add_extra_printer_slots_to_organizations

Revision ID: 426df3a62f96
Revises: e3f5e63cd2b2
Create Date: 2026-05-24 08:36:43.727184

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '426df3a62f96'
down_revision: Union[str, None] = 'e3f5e63cd2b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('organizations', sa.Column('extra_printer_slots', sa.Integer(), server_default='0', nullable=False))


def downgrade() -> None:
    op.drop_column('organizations', 'extra_printer_slots')
