"""add tg bot token to organizations

Revision ID: e3f5e63cd2b2
Revises: 0020
Create Date: 2026-05-23 22:52:47.375792

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e3f5e63cd2b2'
down_revision: Union[str, None] = '0020'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('organizations', sa.Column('tg_bot_token', sa.String(512), nullable=False, server_default=''))
    op.add_column('organizations', sa.Column('tg_bot_username', sa.String(64), nullable=False, server_default=''))


def downgrade() -> None:
    op.drop_column('organizations', 'tg_bot_username')
    op.drop_column('organizations', 'tg_bot_token')
