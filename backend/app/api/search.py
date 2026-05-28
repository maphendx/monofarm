from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_org
from app.core.db import get_db
from app.models.filament import Filament
from app.models.gcode_file import GcodeFile
from app.models.organization import Organization
from app.models.printer import Printer
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
    p_filter = (
        Product.name.ilike(f"%{q}%")
        | Product.sku.ilike(f"%{q}%")
        | Product.barcode.ilike(f"%{q}%")
    )
    if is_int:
        p_filter = p_filter | (Product.id == int(q))
    products = (
        db.query(Product)
        .filter(Product.organization_id == org.id, Product.is_active.is_(True))
        .filter(p_filter)
        .limit(8)
        .all()
    )

    # Filaments: material, color, brand, SKU, label_id, ID
    f_filter = (
        Filament.material.ilike(f"%{q}%")
        | Filament.color.ilike(f"%{q}%")
        | Filament.brand.ilike(f"%{q}%")
        | Filament.sku.ilike(f"%{q}%")
        | Filament.label_id.ilike(f"%{q}%")
    )
    if is_int:
        f_filter = f_filter | (Filament.id == int(q))
    filaments = (
        db.query(Filament)
        .filter(Filament.organization_id == org.id)
        .filter(f_filter)
        .limit(8)
        .all()
    )

    # GCode/3MF files: original_name
    g_filter = GcodeFile.original_name.ilike(f"%{q}%")
    if is_int:
        g_filter = g_filter | (GcodeFile.id == int(q))
    files = (
        db.query(GcodeFile)
        .filter(GcodeFile.organization_id == org.id)
        .filter(g_filter)
        .limit(8)
        .all()
    )

    # Printers: name, moonraker_url, bambu_dev_id
    pr_filter = Printer.name.ilike(f"%{q}%")
    if is_int:
        pr_filter = pr_filter | (Printer.id == int(q))
    printers = (
        db.query(Printer)
        .filter(Printer.organization_id == org.id, Printer.is_active.is_(True))
        .filter(pr_filter)
        .limit(6)
        .all()
    )

    return {
        "products": [
            {"id": p.id, "name": p.name, "sku": p.sku, "barcode": p.barcode, "href": f"/warehouse/products/{p.id}"}
            for p in products
        ],
        "filaments": [
            {"id": f.id, "label": f"{f.material} {f.color}", "brand": f.brand, "sku": f.sku, "label_id": f.label_id, "href": "/filament"}
            for f in filaments
        ],
        "files": [
            {"id": g.id, "name": g.original_name, "href": "/files"}
            for g in files
        ],
        "printers": [
            {"id": p.id, "name": p.name, "kind": p.kind, "href": f"/printers/{p.id}"}
            for p in printers
        ],
    }
