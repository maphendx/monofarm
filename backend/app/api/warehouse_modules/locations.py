"""Warehouses, zones, cells, putaway, and relocation endpoints."""
from decimal import Decimal


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from app.api.ws import broadcast_warehouse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    CellMoveKind, CellMovement, CellStock, MovementType, StockEntry, Warehouse, WarehouseCell, WarehouseMovement,
    WarehouseZone, Product,
)
from app.schemas.warehouse import (
    CellAssign, CellMovementOut, CellNotesUpdate, CellOut, CellStockOut, CellStockSet,
    ScanAction, ScanActionRequest, ScanActionResult, ProductCellLocationOut, ProductLocationsOut, ProductWarehouseLocationOut,
    PutawayRequest, RelocateRequest, UnassignedItemOut, WarehouseCreate, WarehouseOut, WarehouseUpdate,
    ZoneCreate, ZoneOut, ZoneOverviewOut, ZoneUpdate, ZoneWithCellsOut,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_apply_movement, _cell_warehouse_id, _check_and_auto_replenish, _get_cell, _get_product, _get_warehouse, _lock_stock_row, _log_cell_move, _pick_from_cell, _product_image_url, _putaway, _unassigned_qty)
from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset

# ── Warehouses ────────────────────────────────────────────────────────────────

@full_router.get("/warehouses", response_model=list[WarehouseOut])
def list_warehouses(db: Session = Depends(get_db), org: Organization = Depends(get_current_org)) -> list[WarehouseOut]:
    rows = db.query(Warehouse).filter(Warehouse.organization_id == org.id).order_by(Warehouse.name).all()
    return [WarehouseOut.model_validate(r) for r in rows]


@full_router.post("/warehouses", response_model=WarehouseOut, status_code=status.HTTP_201_CREATED)
def create_warehouse(
    payload: WarehouseCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> WarehouseOut:
    wh = Warehouse(**payload.model_dump(), organization_id=org.id)
    db.add(wh)
    db.commit()
    db.refresh(wh)
    return WarehouseOut.model_validate(wh)


@full_router.patch("/warehouses/{wh_id}", response_model=WarehouseOut)
def update_warehouse(
    wh_id:   int,
    payload: WarehouseUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> WarehouseOut:
    wh = _get_warehouse(wh_id, org, db)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(wh, k, v)
    db.commit()
    db.refresh(wh)
    return WarehouseOut.model_validate(wh)


@full_router.delete("/warehouses/{wh_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_warehouse(
    wh_id: int,
    force: bool       = False,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    wh = _get_warehouse(wh_id, org, db)
    has_stock = db.query(func.count(StockEntry.id)).filter(
        StockEntry.warehouse_id == wh_id,
        StockEntry.quantity > 0,
    ).scalar() or 0
    if has_stock:
        raise HTTPException(
            status_code=400,
            detail=f"Не можна видалити склад — {has_stock} позицій мають ненульовий залишок. Спочатку перемістіть або спишіть товари.",
        )
    has_movements = db.query(func.count(WarehouseMovement.id)).filter(
        (WarehouseMovement.warehouse_from_id == wh_id) | (WarehouseMovement.warehouse_to_id == wh_id)
    ).scalar() or 0
    if has_movements and not force:
        raise HTTPException(
            status_code=400,
            detail=f"Є {has_movements} рухів пов'язаних з цим складом. Щоб видалити разом з історією, підтвердьте примусове видалення.",
        )
    if force:
        # nullify movement references so FK won't block deletion
        db.query(WarehouseMovement).filter(WarehouseMovement.warehouse_from_id == wh_id).update({"warehouse_from_id": None})
        db.query(WarehouseMovement).filter(WarehouseMovement.warehouse_to_id   == wh_id).update({"warehouse_to_id":   None})
        db.query(StockEntry).filter(StockEntry.warehouse_id == wh_id).delete()
    db.delete(wh)
    db.commit()


# ── Zones ─────────────────────────────────────────────────────────────────────

def _col_letter(n: int) -> str:
    """0-based column index → Excel-style letter(s): 0→A, 25→Z, 26→AA …"""
    result = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        result = chr(65 + r) + result
    return result


def _generate_cells(zone: WarehouseZone) -> list[WarehouseCell]:
    """Generate cell codes as row-letter + column-number: row A → A1, A2, …;
    row B → B1, B2, …  Appended row-major so cell id order matches the grid."""
    cells = []
    for r in range(zone.rows):
        for c in range(zone.cols):
            code = f"{_col_letter(r)}{c + 1}"
            cells.append(WarehouseCell(zone_id=zone.id, code=code))
    return cells


def _zone_out(zone: WarehouseZone, db: Session) -> ZoneOut:
    count = db.query(WarehouseCell).filter(WarehouseCell.zone_id == zone.id).count()
    return ZoneOut(
        id=zone.id, name=zone.name, rows=zone.rows, cols=zone.cols,
        sort_order=zone.sort_order, cell_count=count, created_at=zone.created_at,
    )


@full_router.get("/zones", response_model=list[ZoneOverviewOut])
def list_all_zones(
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[ZoneOverviewOut]:
    """Flat overview of every zone across all warehouses (for the Стелажі page)."""
    rows = (
        db.query(WarehouseZone, Warehouse)
        .join(Warehouse, Warehouse.id == WarehouseZone.warehouse_id)
        .filter(WarehouseZone.organization_id == org.id)
        .order_by(Warehouse.name, WarehouseZone.sort_order, WarehouseZone.id)
        .all()
    )
    # One grouped query each for total and filled cell counts (avoids N+1).
    counts = dict(
        db.query(WarehouseCell.zone_id, func.count(WarehouseCell.id))
        .group_by(WarehouseCell.zone_id).all()
    )
    filled = dict(
        db.query(WarehouseCell.zone_id, func.count(func.distinct(WarehouseCell.id)))
        .join(CellStock, CellStock.cell_id == WarehouseCell.id)
        .filter(CellStock.quantity > 0)
        .group_by(WarehouseCell.zone_id).all()
    )
    return [
        ZoneOverviewOut(
            id=z.id, name=z.name, rows=z.rows, cols=z.cols, sort_order=z.sort_order,
            cell_count=counts.get(z.id, 0), created_at=z.created_at,
            warehouse_id=wh.id, warehouse_name=wh.name, filled_cells=filled.get(z.id, 0),
        )
        for z, wh in rows
    ]


@full_router.get("/warehouses/{wh_id}/zones", response_model=list[ZoneOut])
def list_zones(
    wh_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[ZoneOut]:
    _get_warehouse(wh_id, org, db)
    zones = (db.query(WarehouseZone)
               .filter(WarehouseZone.warehouse_id == wh_id, WarehouseZone.organization_id == org.id)
               .order_by(WarehouseZone.sort_order, WarehouseZone.id)
               .all())
    zone_ids = [z.id for z in zones]
    counts = dict(
        db.query(WarehouseCell.zone_id, func.count(WarehouseCell.id))
        .filter(WarehouseCell.zone_id.in_(zone_ids))
        .group_by(WarehouseCell.zone_id)
        .all()
    ) if zone_ids else {}
    return [
        ZoneOut(
            id=z.id,
            name=z.name,
            rows=z.rows,
            cols=z.cols,
            sort_order=z.sort_order,
            cell_count=counts.get(z.id, 0),
            created_at=z.created_at,
        )
        for z in zones
    ]


@full_router.post("/warehouses/{wh_id}/zones", response_model=ZoneOut, status_code=status.HTTP_201_CREATED)
def create_zone(
    wh_id:   int,
    payload: ZoneCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ZoneOut:
    _get_warehouse(wh_id, org, db)
    zone = WarehouseZone(**payload.model_dump(), warehouse_id=wh_id, organization_id=org.id)
    db.add(zone)
    db.flush()
    for cell in _generate_cells(zone):
        db.add(cell)
    db.commit()
    db.refresh(zone)
    return _zone_out(zone, db)


@full_router.patch("/warehouses/{wh_id}/zones/{zone_id}", response_model=ZoneOut)
def update_zone(
    wh_id:   int,
    zone_id: int,
    payload: ZoneUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ZoneOut:
    _get_warehouse(wh_id, org, db)
    zone = db.query(WarehouseZone).filter(
        WarehouseZone.id == zone_id, WarehouseZone.warehouse_id == wh_id,
        WarehouseZone.organization_id == org.id,
    ).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    data = payload.model_dump(exclude_unset=True)
    # Only a real change in dimensions counts as a resize; renaming a zone whose
    # rows/cols are re-sent unchanged must not wipe and regenerate its cells.
    resize = data.get("rows", zone.rows) != zone.rows or data.get("cols", zone.cols) != zone.cols
    if resize:
        occupied = (
            db.query(func.count(CellStock.id))
            .join(WarehouseCell, CellStock.cell_id == WarehouseCell.id)
            .filter(WarehouseCell.zone_id == zone.id)
            .scalar() or 0
        )
        if occupied:
            raise HTTPException(
                status_code=400,
                detail=f"Не можна змінити розмір стелажу — {occupied} комірок містять товари. Спочатку очистіть їх.",
            )
    for k, v in data.items():
        setattr(zone, k, v)
    if resize:
        db.query(WarehouseCell).filter(WarehouseCell.zone_id == zone.id).delete()
        for cell in _generate_cells(zone):
            db.add(cell)
    db.commit()
    db.refresh(zone)
    return _zone_out(zone, db)


@full_router.delete("/warehouses/{wh_id}/zones/{zone_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_zone(
    wh_id:   int,
    zone_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    _get_warehouse(wh_id, org, db)
    zone = db.query(WarehouseZone).filter(
        WarehouseZone.id == zone_id, WarehouseZone.warehouse_id == wh_id,
        WarehouseZone.organization_id == org.id,
    ).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    occupied = (
        db.query(func.count(CellStock.id))
        .join(WarehouseCell, CellStock.cell_id == WarehouseCell.id)
        .filter(WarehouseCell.zone_id == zone.id)
        .scalar() or 0
    )
    if occupied:
        raise HTTPException(
            status_code=400,
            detail=f"Не можна видалити стелаж — {occupied} комірок містять товари. Спочатку очистіть їх.",
        )
    db.delete(zone)
    db.commit()


# ── Cells ─────────────────────────────────────────────────────────────────────

def _cell_stock_out(cs: CellStock, org_id: int) -> CellStockOut:
    return CellStockOut(
        product_id=cs.product_id,
        product_name=cs.product.name,
        product_sku=cs.product.sku,
        product_unit=cs.product.unit,
        quantity=cs.quantity,
        image_url=_product_image_url(cs.product, org_id),
    )


def _cells_out_for_zones(zone_ids: list[int], org_id: int, db: Session) -> dict[int, list[CellOut]]:
    """Cells + stock for many zones in two queries (avoids per-cell N+1)."""
    if not zone_ids:
        return {}
    # Order by id = generation (row-major) order, so the CSS grid lays cells out
    # correctly regardless of code string sorting (e.g. A10 vs A2).
    cells = (db.query(WarehouseCell)
               .filter(WarehouseCell.zone_id.in_(zone_ids))
               .order_by(WarehouseCell.id)
               .all())
    stock_by_cell: dict[int, list[CellStock]] = {}
    if cells:
        stock_rows = (db.query(CellStock)
                        .filter(CellStock.cell_id.in_([c.id for c in cells]))
                        .all())
        for cs in stock_rows:
            stock_by_cell.setdefault(cs.cell_id, []).append(cs)
    out: dict[int, list[CellOut]] = {zid: [] for zid in zone_ids}
    for cell in cells:
        out[cell.zone_id].append(CellOut(
            id=cell.id, code=cell.code, notes=cell.notes,
            stock=[_cell_stock_out(cs, org_id) for cs in stock_by_cell.get(cell.id, [])],
        ))
    return out


@full_router.get("/zones/{zone_id}/cells", response_model=ZoneWithCellsOut)
def get_zone_cells(
    zone_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> ZoneWithCellsOut:
    zone = db.query(WarehouseZone).filter(
        WarehouseZone.id == zone_id, WarehouseZone.organization_id == org.id,
    ).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    cells_out = _cells_out_for_zones([zone_id], org.id, db)[zone_id]
    return ZoneWithCellsOut(
        id=zone.id, name=zone.name, rows=zone.rows, cols=zone.cols,
        sort_order=zone.sort_order, cell_count=len(cells_out), created_at=zone.created_at,
        cells=cells_out,
    )


@full_router.get("/warehouses/{wh_id}/zones-with-cells", response_model=list[ZoneWithCellsOut])
def list_zones_with_cells(
    wh_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[ZoneWithCellsOut]:
    """Return all zones + their cells for a warehouse in one call."""
    _get_warehouse(wh_id, org, db)
    zones = (db.query(WarehouseZone)
               .filter(WarehouseZone.warehouse_id == wh_id, WarehouseZone.organization_id == org.id)
               .order_by(WarehouseZone.sort_order, WarehouseZone.id)
               .all())
    cells_by_zone = _cells_out_for_zones([z.id for z in zones], org.id, db)
    return [
        ZoneWithCellsOut(
            id=zone.id, name=zone.name, rows=zone.rows, cols=zone.cols,
            sort_order=zone.sort_order, cell_count=len(cells_by_zone[zone.id]),
            created_at=zone.created_at, cells=cells_by_zone[zone.id],
        )
        for zone in zones
    ]


@full_router.put("/cells/{cell_id}/stock", response_model=CellStockOut)
def set_cell_stock(
    cell_id: int,
    payload: CellStockSet,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CellStockOut:
    """Set the absolute quantity of a product in a cell.

    The delta is drawn from / returned to the warehouse's unassigned pool so the
    invariant sum(cells) <= StockEntry.quantity always holds. Raising a cell
    above the unassigned amount is rejected.
    """
    cell = _get_cell(cell_id, org, db)
    product = db.query(Product).filter(
        Product.id == payload.product_id, Product.organization_id == org.id,
    ).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    wh_id   = _cell_warehouse_id(cell, db)
    _lock_stock_row(payload.product_id, wh_id, org.id, db)
    cs      = db.query(CellStock).filter_by(cell_id=cell_id, product_id=payload.product_id).first()
    current = cs.quantity if cs else Decimal("0")
    delta   = payload.quantity - current

    if delta > 0:
        avail = _unassigned_qty(payload.product_id, wh_id, org.id, db)
        if delta > avail:
            raise HTTPException(
                status_code=400,
                detail=f"Нерозкладено лише {avail} {product.unit} на цьому складі",
            )
        _putaway(cell, payload.product_id, delta, org.id, db,
                 kind=CellMoveKind.adjust, created_by_id=user.id)
    elif delta < 0:
        _pick_from_cell(cell, payload.product_id, -delta, org.id, db,
                        kind=CellMoveKind.adjust, created_by_id=user.id)

    # Keep the CellStock row even when quantity reaches 0 so the product
    # stays registered in the cell.
    cs = db.query(CellStock).filter_by(cell_id=cell_id, product_id=payload.product_id).first()
    if cs is None:
        db.add(CellStock(cell_id=cell_id, product_id=payload.product_id, quantity=Decimal("0")))

    db.commit()
    return CellStockOut(
        product_id=payload.product_id, product_name=product.name,
        product_sku=product.sku, product_unit=product.unit, quantity=payload.quantity,
        image_url=_product_image_url(product, org.id),
    )


@full_router.delete("/cells/{cell_id}/stock/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_cell_stock(
    cell_id:    int,
    product_id: int,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    """Empty a cell — the quantity returns to the warehouse's unassigned pool."""
    cell = _get_cell(cell_id, org, db)
    cs = db.query(CellStock).filter_by(cell_id=cell_id, product_id=product_id).first()
    if cs:
        took = _pick_from_cell(cell, product_id, cs.quantity, org.id, db,
                               kind=CellMoveKind.adjust, created_by_id=user.id)
        if took == 0:
            db.delete(cs)
    db.commit()


@full_router.post("/cells/{cell_id}/assign", response_model=CellStockOut, status_code=status.HTTP_201_CREATED)
def assign_cell_product(
    cell_id: int,
    payload: CellAssign,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CellStockOut:
    """Assign a product to a cell. qty=0 → ADJUSTMENT (register only); qty>0 → PURCHASE_IN."""
    cell = _get_cell(cell_id, org, db)
    product = db.query(Product).filter_by(id=payload.product_id, organization_id=org.id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    if payload.quantity < 0:
        raise HTTPException(status_code=400, detail="Кількість не може бути від'ємною")

    wh_id = _cell_warehouse_id(cell, db)
    if payload.quantity > 0:
        _lock_stock_row(payload.product_id, wh_id, org.id, db)
    mtype = MovementType.PURCHASE_IN if payload.quantity > 0 else MovementType.ADJUSTMENT
    reason = (
        f"Отримання в комірку {cell.code}"
        if payload.quantity > 0
        else f"Реєстрація в комірку {cell.code}"
    )
    m = WarehouseMovement(
        organization_id=org.id,
        type=mtype,
        product_id=payload.product_id,
        warehouse_to_id=wh_id,
        quantity=payload.quantity,
        reason=reason,
        created_by_id=user.id,
    )
    db.add(m)
    db.flush()
    _apply_movement(m, db)
    if payload.quantity > 0:
        _putaway(cell, payload.product_id, payload.quantity, org.id, db,
                 kind=CellMoveKind.putaway, movement_id=m.id, created_by_id=user.id)
    else:
        cs_existing = db.query(CellStock).filter_by(cell_id=cell.id, product_id=payload.product_id).first()
        if not cs_existing:
            db.add(CellStock(cell_id=cell.id, product_id=payload.product_id, quantity=Decimal("0")))
    db.commit()

    cs = db.query(CellStock).filter_by(cell_id=cell_id, product_id=payload.product_id).first()
    return CellStockOut(
        product_id=payload.product_id,
        product_name=product.name,
        product_sku=product.sku,
        product_unit=product.unit,
        quantity=cs.quantity if cs else Decimal("0"),
        image_url=_product_image_url(product, org.id),
    )


@full_router.patch("/cells/{cell_id}", response_model=CellOut)
def update_cell(
    cell_id: int,
    payload: CellNotesUpdate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CellOut:
    """Edit a cell's free-text note (e.g. «верхня полиця»)."""
    cell = _get_cell(cell_id, org, db)
    cell.notes = (payload.notes or "").strip() or None
    db.commit()
    stock_rows = db.query(CellStock).filter(CellStock.cell_id == cell.id).all()
    return CellOut(
        id=cell.id, code=cell.code, notes=cell.notes,
        stock=[_cell_stock_out(cs, org.id) for cs in stock_rows],
    )


# ── Putaway / relocate / locations ────────────────────────────────────────────

@full_router.get("/warehouses/{wh_id}/unassigned", response_model=list[UnassignedItemOut])
def list_unassigned(
    wh_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[UnassignedItemOut]:
    """Products with floor stock not yet put away into a cell in this warehouse."""
    _get_warehouse(wh_id, org, db)
    entries = (
        db.query(StockEntry, Product)
        .join(Product, Product.id == StockEntry.product_id)
        .filter(StockEntry.organization_id == org.id,
                StockEntry.warehouse_id == wh_id,
                StockEntry.quantity > 0)
        .order_by(Product.name)
        .all()
    )
    # One grouped query for all cell allocations in this warehouse (avoids N+1).
    assigned_map = dict(
        db.query(CellStock.product_id, func.sum(CellStock.quantity))
        .join(WarehouseCell, WarehouseCell.id == CellStock.cell_id)
        .join(WarehouseZone, WarehouseZone.id == WarehouseCell.zone_id)
        .filter(WarehouseZone.warehouse_id == wh_id, CellStock.quantity > 0)
        .group_by(CellStock.product_id)
        .all()
    )
    out: list[UnassignedItemOut] = []
    for e, p in entries:
        unassigned = e.quantity - assigned_map.get(p.id, Decimal("0"))
        if unassigned > 0:
            out.append(UnassignedItemOut(
                product_id=p.id, product_name=p.name, product_sku=p.sku,
                unit=p.unit, unassigned=unassigned,
            ))
    return out


@full_router.post("/cells/{cell_id}/putaway", response_model=CellStockOut)
def putaway_to_cell(
    cell_id: int,
    payload: PutawayRequest,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CellStockOut:
    """Move quantity from the unassigned pool into a cell."""
    cell = _get_cell(cell_id, org, db)
    product = db.query(Product).filter_by(id=payload.product_id, organization_id=org.id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    if payload.quantity <= 0:
        raise HTTPException(status_code=400, detail="Кількість має бути більшою за 0")

    wh_id = _cell_warehouse_id(cell, db)
    _lock_stock_row(payload.product_id, wh_id, org.id, db)
    avail = _unassigned_qty(payload.product_id, wh_id, org.id, db)
    if payload.quantity > avail:
        raise HTTPException(
            status_code=400,
            detail=f"Нерозкладено лише {avail} {product.unit} на цьому складі",
        )
    _putaway(cell, payload.product_id, payload.quantity, org.id, db, created_by_id=user.id)
    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "stock")

    cs = db.query(CellStock).filter_by(cell_id=cell_id, product_id=payload.product_id).first()
    return CellStockOut(
        product_id=payload.product_id, product_name=product.name,
        product_sku=product.sku, product_unit=product.unit, quantity=cs.quantity if cs else Decimal("0"),
        image_url=_product_image_url(product, org.id),
    )


@full_router.post("/cells/relocate", status_code=status.HTTP_204_NO_CONTENT)
def relocate_between_cells(
    payload: RelocateRequest,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    """Move quantity from one cell to another within the same warehouse."""
    if payload.quantity <= 0:
        raise HTTPException(status_code=400, detail="Кількість має бути більшою за 0")
    if payload.from_cell_id == payload.to_cell_id:
        raise HTTPException(status_code=400, detail="Комірки збігаються")
    src = _get_cell(payload.from_cell_id, org, db)
    dst = _get_cell(payload.to_cell_id, org, db)
    if _cell_warehouse_id(src, db) != _cell_warehouse_id(dst, db):
        raise HTTPException(status_code=400, detail="Переміщення можливе лише в межах одного складу")

    _lock_stock_row(payload.product_id, _cell_warehouse_id(src, db), org.id, db)
    src_cs = db.query(CellStock).filter_by(cell_id=src.id, product_id=payload.product_id).first()
    if not src_cs or src_cs.quantity < payload.quantity:
        have = src_cs.quantity if src_cs else Decimal("0")
        raise HTTPException(status_code=400, detail=f"У комірці лише {have}")

    src_cs.quantity -= payload.quantity
    if src_cs.quantity <= 0:
        db.delete(src_cs)
    dst_cs = db.query(CellStock).filter_by(cell_id=dst.id, product_id=payload.product_id).first()
    if dst_cs:
        dst_cs.quantity += payload.quantity
    else:
        db.add(CellStock(cell_id=dst.id, product_id=payload.product_id, quantity=payload.quantity))
    _log_cell_move(db, org_id=org.id, product_id=payload.product_id, quantity=payload.quantity,
                   kind=CellMoveKind.relocate, cell_from_id=src.id, cell_to_id=dst.id,
                   created_by_id=user.id)
    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "stock")


@full_router.post("/scan-action", response_model=ScanActionResult)
def scan_action(
    payload: ScanActionRequest,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ScanActionResult:
    """Execute a warehouse operation chosen via a functional ACTION QR.

    write_off      — remove qty from a cell and the warehouse ledger (WRITE_OFF).
    transfer       — cell → cell: relocate within a warehouse, or TRANSFER across.
    receive        — book qty into a cell (PURCHASE_IN); unit_cost optional → AVCO.
    stocktake      — set a cell to the counted qty and correct the warehouse total.
    sale_out       — ship qty from a cell (SALE_OUT); unit_price optional → revenue.
    defect         — mark qty defective, remove from a cell (DEFECT).
    production_in  — book finished goods into a cell (PRODUCTION_IN).
    production_out — issue components to production from a cell (PRODUCTION_OUT).
    """
    product = _get_product(payload.product_id, org, db)
    if payload.quantity < 0 or (payload.quantity == 0 and payload.action != ScanAction.stocktake):
        raise HTTPException(status_code=400, detail="Кількість має бути > 0")

    cell  = _get_cell(payload.cell_id, org, db)
    wh_id = _cell_warehouse_id(cell, db)
    _lock_stock_row(payload.product_id, wh_id, org.id, db)

    def _outbound(mtype: MovementType, reason: str, *,
                  unit_price: Decimal | None = None, replenish: bool = False) -> int:
        """Pick qty from the cell and decrement the warehouse via an outbound ledger move."""
        cs   = db.query(CellStock).filter_by(cell_id=cell.id, product_id=payload.product_id).first()
        have = cs.quantity if cs else Decimal("0")
        if have < payload.quantity:
            raise HTTPException(status_code=400, detail=f"У комірці лише {have}")
        revenue = (payload.quantity * unit_price) if unit_price else None
        m = WarehouseMovement(
            organization_id=org.id, type=mtype,
            product_id=payload.product_id, warehouse_from_id=wh_id,
            quantity=payload.quantity, unit_price=unit_price, total_revenue=revenue,
            reason=reason, created_by_id=user.id,
        )
        db.add(m)
        db.flush()
        # Pick from the cell BEFORE _apply_movement so the FIFO clamp leaves it alone.
        _pick_from_cell(cell, payload.product_id, payload.quantity, org.id, db,
                        movement_id=m.id, created_by_id=user.id)
        _apply_movement(m, db)
        if replenish:
            _check_and_auto_replenish(payload.product_id, org.id, db)
        db.commit()
        return m.id

    def _inbound(mtype: MovementType, reason: str, *, unit_cost: Decimal | None = None) -> int:
        """Add qty to the warehouse via an inbound ledger move and put it away into the cell."""
        total = (payload.quantity * unit_cost) if unit_cost else None
        m = WarehouseMovement(
            organization_id=org.id, type=mtype,
            product_id=payload.product_id, warehouse_to_id=wh_id,
            quantity=payload.quantity, unit_cost=unit_cost, total_cost=total,
            reason=reason, created_by_id=user.id,
        )
        db.add(m)
        db.flush()
        _apply_movement(m, db)   # AVCO before stock add when unit_cost is set
        avail = _unassigned_qty(payload.product_id, wh_id, org.id, db)
        _putaway(cell, payload.product_id, min(payload.quantity, avail), org.id, db,
                 movement_id=m.id, created_by_id=user.id)
        db.commit()
        return m.id

    # ── Переміщення: cell → cell (relocate), or warehouse → warehouse (TRANSFER) ─
    if payload.action == ScanAction.transfer:
        if not payload.to_cell_id:
            raise HTTPException(status_code=400, detail="Не вказано комірку призначення")
        if payload.to_cell_id == cell.id:
            raise HTTPException(status_code=400, detail="Комірки збігаються")
        dst    = _get_cell(payload.to_cell_id, org, db)
        dst_wh = _cell_warehouse_id(dst, db)
        src_cs = db.query(CellStock).filter_by(cell_id=cell.id, product_id=payload.product_id).first()
        if not src_cs or src_cs.quantity < payload.quantity:
            have = src_cs.quantity if src_cs else Decimal("0")
            raise HTTPException(status_code=400, detail=f"У комірці лише {have}")

        if dst_wh == wh_id:
            # Same warehouse → pure relocate; warehouse total unchanged.
            src_cs.quantity -= payload.quantity
            if src_cs.quantity <= 0:
                db.delete(src_cs)
            dst_cs = db.query(CellStock).filter_by(cell_id=dst.id, product_id=payload.product_id).first()
            if dst_cs:
                dst_cs.quantity += payload.quantity
            else:
                db.add(CellStock(cell_id=dst.id, product_id=payload.product_id, quantity=payload.quantity))
            _log_cell_move(db, org_id=org.id, product_id=payload.product_id, quantity=payload.quantity,
                           kind=CellMoveKind.relocate, cell_from_id=cell.id, cell_to_id=dst.id,
                           created_by_id=user.id)
            db.commit()
            bg.add_task(broadcast_warehouse, org.id, "stock")
            return ScanActionResult(message=f"Переміщено {payload.quantity} {product.unit}: {cell.code} → {dst.code}")

        # Cross-warehouse → real TRANSFER ledger movement (decrements src wh, adds dst wh).
        _lock_stock_row(payload.product_id, dst_wh, org.id, db)
        m = WarehouseMovement(
            organization_id=org.id, type=MovementType.TRANSFER,
            product_id=payload.product_id, warehouse_from_id=wh_id, warehouse_to_id=dst_wh,
            quantity=payload.quantity, reason=f"Переміщення між складами (скан) {cell.code} → {dst.code}",
            created_by_id=user.id,
        )
        db.add(m)
        db.flush()
        _pick_from_cell(cell, payload.product_id, payload.quantity, org.id, db,
                        movement_id=m.id, created_by_id=user.id)
        _apply_movement(m, db)   # src wh -= qty, dst wh += qty, clamps cells in both
        avail = _unassigned_qty(payload.product_id, dst_wh, org.id, db)
        _putaway(dst, payload.product_id, min(payload.quantity, avail), org.id, db,
                 movement_id=m.id, created_by_id=user.id)
        db.commit()
        bg.add_task(broadcast_warehouse, org.id, "stock")
        return ScanActionResult(message=f"Переміщено між складами {payload.quantity} {product.unit}: {cell.code} → {dst.code}", movement_id=m.id)

    # ── Списання (WRITE_OFF) ───────────────────────────────────────────────────
    if payload.action == ScanAction.write_off:
        mid = _outbound(MovementType.WRITE_OFF, f"Списання (скан) з {cell.code}")
        bg.add_task(broadcast_warehouse, org.id, "stock")
        return ScanActionResult(message=f"Списано {payload.quantity} {product.unit} з {cell.code}", movement_id=mid)

    # ── Відвантаження (SALE_OUT); unit_price optional → revenue ────────────────
    if payload.action == ScanAction.sale_out:
        mid = _outbound(MovementType.SALE_OUT, f"Відвантаження (скан) з {cell.code}",
                        unit_price=payload.unit_price, replenish=True)
        bg.add_task(broadcast_warehouse, org.id, "stock")
        return ScanActionResult(message=f"Відвантажено {payload.quantity} {product.unit} з {cell.code}", movement_id=mid)

    # ── Брак (DEFECT) ──────────────────────────────────────────────────────────
    if payload.action == ScanAction.defect:
        mid = _outbound(MovementType.DEFECT, f"Брак (скан) з {cell.code}", replenish=True)
        bg.add_task(broadcast_warehouse, org.id, "stock")
        return ScanActionResult(message=f"Брак {payload.quantity} {product.unit} з {cell.code}", movement_id=mid)

    # ── Видача у виробництво (PRODUCTION_OUT) ──────────────────────────────────
    if payload.action == ScanAction.production_out:
        mid = _outbound(MovementType.PRODUCTION_OUT, f"Видача у виробництво (скан) з {cell.code}", replenish=True)
        bg.add_task(broadcast_warehouse, org.id, "stock")
        return ScanActionResult(message=f"Видано у виробництво {payload.quantity} {product.unit} з {cell.code}", movement_id=mid)

    # ── Прийом (PURCHASE_IN); unit_cost optional → AVCO ────────────────────────
    if payload.action == ScanAction.receive:
        mid = _inbound(MovementType.PURCHASE_IN, f"Прийом (скан) у {cell.code}", unit_cost=payload.unit_cost)
        bg.add_task(broadcast_warehouse, org.id, "stock")
        return ScanActionResult(message=f"Прийнято {payload.quantity} {product.unit} у {cell.code}", movement_id=mid)

    # ── Оприбуткування з виробництва (PRODUCTION_IN) ───────────────────────────
    if payload.action == ScanAction.production_in:
        mid = _inbound(MovementType.PRODUCTION_IN, f"Оприбуткування з виробництва (скан) у {cell.code}")
        bg.add_task(broadcast_warehouse, org.id, "stock")
        return ScanActionResult(message=f"Оприбутковано {payload.quantity} {product.unit} у {cell.code}", movement_id=mid)

    # ── Інвентаризація: set cell to counted qty, correct warehouse total ───────
    cs      = db.query(CellStock).filter_by(cell_id=cell.id, product_id=payload.product_id).first()
    current = cs.quantity if cs else Decimal("0")
    delta   = payload.quantity - current
    if delta == 0:
        if cs is None:
            db.add(CellStock(cell_id=cell.id, product_id=payload.product_id, quantity=Decimal("0")))
            db.commit()
        return ScanActionResult(message=f"{cell.code}: без змін ({current} {product.unit})")
    if delta > 0:
        m = WarehouseMovement(
            organization_id=org.id, type=MovementType.ADJUSTMENT,
            product_id=payload.product_id, warehouse_to_id=wh_id,
            quantity=delta, reason=f"Інвентаризація {cell.code} (надлишок)",
            created_by_id=user.id,
        )
        db.add(m)
        db.flush()
        _apply_movement(m, db)   # total += delta
        _putaway(cell, payload.product_id, delta, org.id, db,
                 movement_id=m.id, created_by_id=user.id)
    else:
        short = -delta
        m = WarehouseMovement(
            organization_id=org.id, type=MovementType.WRITE_OFF,
            product_id=payload.product_id, warehouse_from_id=wh_id,
            quantity=short, reason=f"Інвентаризація {cell.code} (нестача)",
            created_by_id=user.id,
        )
        db.add(m)
        db.flush()
        _pick_from_cell(cell, payload.product_id, short, org.id, db,
                        movement_id=m.id, created_by_id=user.id)
        _apply_movement(m, db)   # total -= short
    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "stock")
    return ScanActionResult(message=f"Інвентаризація {cell.code}: {current} → {payload.quantity} {product.unit}", movement_id=m.id)


@full_router.get("/products/{product_id}/locations", response_model=ProductLocationsOut)
def product_locations(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> ProductLocationsOut:
    """Where a product physically sits: cells + unassigned pool, per warehouse."""
    _get_product(product_id, org, db)
    entries = (
        db.query(StockEntry, Warehouse)
        .join(Warehouse, Warehouse.id == StockEntry.warehouse_id)
        .filter(StockEntry.organization_id == org.id,
                StockEntry.product_id == product_id,
                StockEntry.quantity > 0)
        .order_by(Warehouse.name)
        .all()
    )
    wh_ids = [wh.id for _, wh in entries]
    cells_by_warehouse: dict[int, list[ProductCellLocationOut]] = {wh_id: [] for wh_id in wh_ids}
    if wh_ids:
        cell_rows = (
            db.query(CellStock, WarehouseCell, WarehouseZone)
            .join(WarehouseCell, WarehouseCell.id == CellStock.cell_id)
            .join(WarehouseZone, WarehouseZone.id == WarehouseCell.zone_id)
            .filter(
                WarehouseZone.organization_id == org.id,
                WarehouseZone.warehouse_id.in_(wh_ids),
                CellStock.product_id == product_id,
                CellStock.quantity > 0,
            )
            .order_by(WarehouseZone.name, WarehouseCell.code)
            .all()
        )
        for cs, c, z in cell_rows:
            cells_by_warehouse.setdefault(z.warehouse_id, []).append(
                ProductCellLocationOut(cell_id=c.id, zone_name=z.name, code=c.code, quantity=cs.quantity)
            )

    warehouses: list[ProductWarehouseLocationOut] = []
    for e, wh in entries:
        cells = cells_by_warehouse.get(wh.id, [])
        assigned = sum((c.quantity for c in cells), Decimal("0"))
        warehouses.append(ProductWarehouseLocationOut(
            warehouse_id=wh.id, warehouse_name=wh.name, cells=cells,
            unassigned=e.quantity - assigned, total=e.quantity,
        ))
    return ProductLocationsOut(product_id=product_id, warehouses=warehouses)


@full_router.get("/products/{product_id}/cell-history", response_model=list[CellMovementOut])
def product_cell_history(
    product_id: int,
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[CellMovementOut]:
    """Audit trail of bin relocations for a product (newest first)."""
    _get_product(product_id, org, db)
    rows = (
        db.query(CellMovement)
        .filter(CellMovement.organization_id == org.id, CellMovement.product_id == product_id)
        .order_by(CellMovement.created_at.desc(), CellMovement.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    cell_ids = {cid for r in rows for cid in (r.cell_from_id, r.cell_to_id) if cid}
    labels: dict[int, str] = {}
    if cell_ids:
        for cell_id, zone_name, cell_code in (
            db.query(WarehouseCell.id, WarehouseZone.name, WarehouseCell.code)
            .join(WarehouseZone, WarehouseZone.id == WarehouseCell.zone_id)
            .filter(WarehouseCell.id.in_(cell_ids), WarehouseZone.organization_id == org.id)
            .all()
        ):
            labels[cell_id] = f"{zone_name} {cell_code}"

    p = _get_product(product_id, org, db)
    return [
        CellMovementOut(
            id=r.id, product_id=r.product_id, product_name=p.name,
            quantity=r.quantity, kind=r.kind.value,
            cell_from=labels.get(r.cell_from_id) if r.cell_from_id else None,
            cell_to=labels.get(r.cell_to_id) if r.cell_to_id else None,
            created_at=r.created_at,
        )
        for r in rows
    ]
