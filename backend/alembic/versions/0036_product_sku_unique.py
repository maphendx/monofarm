"""product sku unique per org

Revision ID: 0036
Revises: 0035
Create Date: 2026-05-28
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0036"
down_revision: Union[str, None] = "0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # Deduplicate: append _2, _3… to duplicate SKUs within same org
    dupes = conn.execute(sa.text("""
        SELECT organization_id, sku
        FROM wh_products
        GROUP BY organization_id, sku
        HAVING count(*) > 1
    """)).fetchall()

    for org_id, sku in dupes:
        rows = conn.execute(sa.text(
            "SELECT id FROM wh_products WHERE organization_id = :o AND sku = :s ORDER BY id"
        ), {"o": org_id, "s": sku}).fetchall()
        for n, (pid,) in enumerate(rows[1:], start=2):
            new_sku = f"{sku}_{n}"
            conn.execute(sa.text(
                "UPDATE wh_products SET sku = :new WHERE id = :id"
            ), {"new": new_sku, "id": pid})

    op.create_unique_constraint(
        "uq_wh_products_org_sku", "wh_products", ["organization_id", "sku"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_wh_products_org_sku", "wh_products", type_="unique")
