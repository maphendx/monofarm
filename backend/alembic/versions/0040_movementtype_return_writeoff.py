"""add RETURN_IN and WRITE_OFF to movementtype enum

Revision ID: 0040
Revises: 0039
Create Date: 2026-05-29

The MovementType enum gained RETURN_IN / WRITE_OFF in application code, but the
native Postgres `movementtype` enum was created long ago with the original
values. Without these labels, creating a return/write-off movement fails at the
DB level. (Tests didn't catch it: the test DB is built via create_all, which
generates the enum fresh with every value.)

"""
from alembic import op

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ALTER TYPE ADD VALUE cannot run inside a transaction on PG<12; on PG16 it
    # can, but the new label cannot be used within the same transaction. We only
    # add the labels here and reference them in application code, so this is safe.
    op.execute("ALTER TYPE movementtype ADD VALUE IF NOT EXISTS 'RETURN_IN'")
    op.execute("ALTER TYPE movementtype ADD VALUE IF NOT EXISTS 'WRITE_OFF'")


def downgrade() -> None:
    # Postgres has no DROP VALUE for enums; removing a label requires recreating
    # the type. Left as a no-op — extra enum labels are harmless.
    pass
