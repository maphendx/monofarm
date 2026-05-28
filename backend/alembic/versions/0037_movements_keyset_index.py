"""movements keyset index for pagination

Revision ID: 0037
Revises: 0036
Create Date: 2026-05-28
"""
from typing import Union

from alembic import op

revision: str = "0037"
down_revision: Union[str, None] = "0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX ix_wh_movements_keyset "
        "ON wh_movements (organization_id, created_at DESC, id DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_wh_movements_keyset")
