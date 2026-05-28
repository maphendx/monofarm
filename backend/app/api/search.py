from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_org
from app.core.db import get_db
from app.models.filament import Filament
from app.models.organization import Organization
from app.models.warehouse import Product

router = APIRouter(tags=["search"])


@router.get("/search")
def universal_search(
    q: str = Query(..., min_length=1, max_length=200),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
):
    q = q.strip()
    is_int = q.isdigit()

    # Products: name, SKU, barcode, ID
    pq = db.query(Product).filter(
        Product.organization_id == org.id,
        Product.is_active.is_(True),
    )
    p_filter = (
        Product.name.ilike(f"%{q}%")
        | Product.sku.ilike(f"%{q}%")
        | Product.barcode.ilike(f"%{q}%")
    )
    if is_int:
        p_filter = p_filter | (Product.id == int(q))
    products = pq.filter(p_filter).limit(8).all()

    # Filaments: material, color, brand, SKU, label_id, ID
    fq = db.query(Filament).filter(Filament.organization_id == org.id)
    f_filter = (
        Filament.material.ilike(f"%{q}%")
        | Filament.color.ilike(f"%{q}%")
        | Filament.brand.ilike(f"%{q}%")
        | Filament.sku.ilike(f"%{q}%")
        | Filament.label_id.ilike(f"%{q}%")
    )
    if is_int:
        f_filter = f_filter | (Filament.id == int(q))
    filaments = fq.filter(f_filter).limit(8).all()

    return {
        "products": [
            {
                "id": p.id,
                "name": p.name,
                "sku": p.sku,
                "barcode": p.barcode,
                "href": f"/warehouse/products/{p.id}",
            }
            for p in products
        ],
        "filaments": [
            {
                "id": f.id,
                "label": f"{f.material} {f.color}",
                "brand": f.brand,
                "sku": f.sku,
                "label_id": f.label_id,
                "href": "/filament",
            }
            for f in filaments
        ],
    }
