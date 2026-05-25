"""filament label_id

Revision ID: 0026
Revises: 0025
Create Date: 2026-05-25
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: Union[str, None] = "0025"
branch_labels = None
depends_on = None

CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ23456789"


def _gen_id(seed: int) -> str:
    import random
    rng = random.Random(seed)
    return "".join(rng.choices(CHARS, k=4))


def upgrade() -> None:
    op.add_column("filaments", sa.Column("label_id", sa.String(4), nullable=True))
    op.create_index("ix_filaments_label_id", "filaments", ["label_id"])

    # Back-fill existing rows with deterministic IDs based on filament.id
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id FROM filaments WHERE label_id IS NULL")).fetchall()
    for (fid,) in rows:
        lid = _gen_id(fid * 9973)
        conn.execute(
            sa.text("UPDATE filaments SET label_id = :lid WHERE id = :fid"),
            {"lid": lid, "fid": fid},
        )


def downgrade() -> None:
    op.drop_index("ix_filaments_label_id", "filaments")
    op.drop_column("filaments", "label_id")
