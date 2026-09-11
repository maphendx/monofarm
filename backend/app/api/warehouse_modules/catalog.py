"""Product-category CRUD and scanner lookup endpoints."""


from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    CellStock, ProductCategory, Warehouse, WarehouseCell, WarehouseZone, Product,
)
from app.schemas.warehouse import (
    CellDetailOut, CellStockOut, ScanResult,
    ProductCategoryCreate, ProductCategoryOut, ProductCategoryUpdate,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_make_product_out, _product_image_url)

# ── Product categories ────────────────────────────────────────────────────────

@full_router.get("/scan", response_model=ScanResult)
def scan(
    q:   str,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> ScanResult:
    """Universal QR/barcode lookup. Accepts CELL:{id}, PROD:{id}, barcode, or SKU."""
    q = q.strip()

    if q.upper().startswith("CELL:"):
        try:
            cell_id = int(q.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Невірний формат CELL")
        row = (
            db.query(WarehouseCell, WarehouseZone, Warehouse)
            .join(WarehouseZone, WarehouseZone.id == WarehouseCell.zone_id)
            .join(Warehouse, Warehouse.id == WarehouseZone.warehouse_id)
            .filter(WarehouseCell.id == cell_id, WarehouseZone.organization_id == org.id)
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Комірку не знайдено")
        cell, zone, wh = row
        stock_rows = (
            db.query(CellStock, Product)
            .join(Product, Product.id == CellStock.product_id)
            .filter(CellStock.cell_id == cell.id, Product.organization_id == org.id)
            .order_by(Product.name, Product.id)
            .all()
        )
        stock_out = [
            CellStockOut(
                product_id=cs.product_id, product_name=p.name,
                product_sku=p.sku, product_unit=p.unit, quantity=cs.quantity,
                image_url=_product_image_url(p, org.id),
            )
            for cs, p in stock_rows
        ]
        detail = CellDetailOut(
            cell_id=cell.id, cell_code=cell.code, cell_notes=cell.notes,
            zone_id=zone.id, zone_name=zone.name,
            warehouse_id=wh.id, warehouse_name=wh.name,
            stock=stock_out,
        )
        return ScanResult(type="cell", cell=detail)

    # PROD:{id} or barcode or sku
    pid: int | None = None
    if q.upper().startswith("PROD:"):
        try:
            pid = int(q.split(":", 1)[1])
        except ValueError:
            pass
    p = None
    if pid:
        p = db.query(Product).filter_by(id=pid, organization_id=org.id).first()
    if not p:
        p = db.query(Product).filter_by(barcode=q, organization_id=org.id).first()
    if not p:
        p = db.query(Product).filter_by(sku=q, organization_id=org.id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Не знайдено")
    return ScanResult(type="product", product=_make_product_out(p, org.id))


@public_router.get("/categories", response_model=list[ProductCategoryOut])
def list_categories(
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[ProductCategoryOut]:
    rows = (
        db.query(ProductCategory)
        .filter(ProductCategory.organization_id == org.id)
        .order_by(ProductCategory.sort_order, ProductCategory.name)
        .all()
    )
    return [ProductCategoryOut.model_validate(r) for r in rows]


@public_router.post("/categories", response_model=ProductCategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: ProductCategoryCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin)),
) -> ProductCategoryOut:
    cat = ProductCategory(**payload.model_dump(), organization_id=org.id)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return ProductCategoryOut.model_validate(cat)


@public_router.patch("/categories/{cat_id}", response_model=ProductCategoryOut)
def update_category(
    cat_id:  int,
    payload: ProductCategoryUpdate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin)),
) -> ProductCategoryOut:
    cat = db.query(ProductCategory).filter_by(id=cat_id, organization_id=org.id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(cat, k, v)
    db.commit()
    db.refresh(cat)
    return ProductCategoryOut.model_validate(cat)


@public_router.delete("/categories/{cat_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    cat_id: int,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin)),
) -> None:
    cat = db.query(ProductCategory).filter_by(id=cat_id, organization_id=org.id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    db.delete(cat)
    db.commit()
