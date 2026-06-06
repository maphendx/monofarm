"""link existing spec components to products

Revision ID: 0053
Revises: 0052
Create Date: 2026-06-06
"""
from __future__ import annotations

import hashlib
import re
import unicodedata

from alembic import op
import sqlalchemy as sa


revision = "0053"
down_revision = "0052"
branch_labels = None
depends_on = None


def _norm(value: str | None) -> str:
    return " ".join((value or "").casefold().split())


def _sku_from_name(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9]+", "-", ascii_name).strip("-").upper()
    if len(slug) < 3:
        slug = "COMP"
    digest = hashlib.sha1(name.casefold().encode("utf-8")).hexdigest()[:8].upper()
    return f"COMP-{slug[:24]}-{digest}"


def _unique_sku(name: str, used_skus: set[str]) -> str:
    base = _sku_from_name(name)[:80]
    candidate = base
    suffix = 2
    while candidate in used_skus:
        tail = f"-{suffix}"
        candidate = f"{base[:80 - len(tail)]}{tail}"
        suffix += 1
    used_skus.add(candidate)
    return candidate


def upgrade() -> None:
    bind = op.get_bind()

    products_by_org_name: dict[int, dict[str, int]] = {}
    skus_by_org: dict[int, set[str]] = {}
    product_rows = bind.execute(sa.text("""
        SELECT id, organization_id, name, sku
        FROM wh_products
    """)).mappings()
    for row in product_rows:
        org_id = row["organization_id"]
        products_by_org_name.setdefault(org_id, {})[_norm(row["name"])] = row["id"]
        skus_by_org.setdefault(org_id, set()).add(row["sku"])

    component_rows = bind.execute(sa.text("""
        SELECT
            c.id,
            c.name,
            c.unit,
            c.unit_price,
            p.organization_id
        FROM wh_spec_components c
        JOIN wh_specifications s ON s.id = c.specification_id
        JOIN wh_products p ON p.id = s.product_id
        WHERE c.product_id IS NULL
    """)).mappings()

    for row in component_rows:
        org_id = row["organization_id"]
        name = (row["name"] or "").strip()
        if not name:
            continue

        product_id = products_by_org_name.setdefault(org_id, {}).get(_norm(name))
        if product_id is None:
            sku = _unique_sku(name, skus_by_org.setdefault(org_id, set()))
            product_id = bind.execute(sa.text("""
                INSERT INTO wh_products (
                    organization_id,
                    name,
                    sku,
                    categories,
                    unit,
                    cost_price,
                    is_active
                )
                VALUES (
                    :organization_id,
                    :name,
                    :sku,
                    '[]'::jsonb,
                    :unit,
                    :cost_price,
                    true
                )
                RETURNING id
            """), {
                "organization_id": org_id,
                "name": name,
                "sku": sku,
                "unit": (row["unit"] or "").strip() or "шт",
                "cost_price": row["unit_price"],
            }).scalar_one()
            products_by_org_name[org_id][_norm(name)] = product_id

        bind.execute(sa.text("""
            UPDATE wh_spec_components
            SET product_id = :product_id,
                name = (SELECT name FROM wh_products WHERE id = :product_id),
                unit = COALESCE(NULLIF(unit, ''), (SELECT unit FROM wh_products WHERE id = :product_id)),
                unit_price = COALESCE(unit_price, (SELECT cost_price FROM wh_products WHERE id = :product_id))
            WHERE id = :component_id
        """), {"product_id": product_id, "component_id": row["id"]})


def downgrade() -> None:
    # Data backfill is intentionally not reversible: deleting generated products
    # could remove user-edited nomenclature after the migration has run.
    pass
