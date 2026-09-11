"""Bulk loading and response construction for production batches."""

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.user import User
from app.models.warehouse import Product, ProductionBatch, SpecComponent, StockEntry
from app.schemas.warehouse import BatchComponentOut, BatchOut

@dataclass
class _BatchPrefetch:
    """Bulk-loaded lookups for serializing many batches without N+1 queries."""
    products:         dict[int, Product]
    comps_by_spec:    dict[int, list[SpecComponent]]
    avail_by_product: dict[int, Decimal]
    task_titles:      dict[int, str]
    user_names:       dict[int, str]


def _build_batch_prefetch(batches: list[ProductionBatch], db: Session) -> _BatchPrefetch:
    org_id = batches[0].organization_id if batches else None
    spec_ids = {b.specification_id for b in batches if b.specification_id}
    comps_by_spec: dict[int, list[SpecComponent]] = {}
    if spec_ids:
        comp_rows = (
            db.query(SpecComponent)
            .filter(SpecComponent.specification_id.in_(spec_ids))
            .order_by(SpecComponent.sort_order)
            .all()
        )
        for c in comp_rows:
            comps_by_spec.setdefault(c.specification_id, []).append(c)

    comp_product_ids = {c.product_id for comps in comps_by_spec.values() for c in comps if c.product_id}
    product_ids = {b.product_id for b in batches} | comp_product_ids
    products = {
        p.id: p
        for p in db.query(Product).filter(
            Product.organization_id == org_id,
            Product.id.in_(product_ids),
        ).all()
    } if product_ids else {}

    # Sum per-entry available (clamped at 0) to match the single-batch path exactly.
    avail_by_product: dict[int, Decimal] = {}
    if comp_product_ids:
        for e in db.query(StockEntry).filter(
            StockEntry.organization_id == org_id,
            StockEntry.product_id.in_(comp_product_ids),
        ).all():
            avail_by_product[e.product_id] = (
                avail_by_product.get(e.product_id, Decimal("0"))
                + max(Decimal("0"), e.quantity - e.reserved_qty)
            )

    task_titles: dict[int, str] = {}
    task_ids = {b.print_task_id for b in batches if b.print_task_id}
    if task_ids:
        from app.models.task import PrintTask
        for t in db.query(PrintTask).filter(PrintTask.organization_id == org_id, PrintTask.id.in_(task_ids)).all():
            task_titles[t.id] = t.title

    user_names: dict[int, str] = {}
    user_ids = {b.assigned_to_id for b in batches if b.assigned_to_id}
    if user_ids:
        for u in db.query(User).filter(User.organization_id == org_id, User.id.in_(user_ids)).all():
            user_names[u.id] = u.name or u.email

    return _BatchPrefetch(
        products=products,
        comps_by_spec=comps_by_spec,
        avail_by_product=avail_by_product,
        task_titles=task_titles,
        user_names=user_names,
    )


def _batch_to_out(b: ProductionBatch, db: Session, pf: "_BatchPrefetch | None" = None) -> BatchOut:
    p = pf.products.get(b.product_id) if pf else db.get(Product, b.product_id)

    components: list[BatchComponentOut] = []
    if b.specification_id:
        if pf is not None:
            spec_comps = pf.comps_by_spec.get(b.specification_id, [])
        else:
            spec_comps = (
                db.query(SpecComponent)
                .filter_by(specification_id=b.specification_id)
                .order_by(SpecComponent.sort_order)
                .all()
            )
        for c in spec_comps:
            total_qty = c.quantity * b.target_qty
            available_stock: Decimal | None = None
            product_name: str | None = None
            if c.product_id:
                if pf is not None:
                    cp = pf.products.get(c.product_id)
                    available_stock = pf.avail_by_product.get(c.product_id, Decimal("0"))
                else:
                    cp = db.query(Product).filter_by(id=c.product_id, organization_id=b.organization_id).first()
                    entries = db.query(StockEntry).filter_by(
                        organization_id=b.organization_id,
                        product_id=c.product_id,
                    ).all()
                    available_stock = sum(
                        (max(Decimal("0"), e.quantity - e.reserved_qty) for e in entries),
                        Decimal("0"),
                    )
                product_name = cp.name if cp else None
            components.append(BatchComponentOut(
                id=c.id,
                name=c.name,
                product_id=c.product_id,
                product_name=product_name,
                quantity=c.quantity,
                unit=c.unit,
                total_qty=total_qty,
                available_stock=available_stock,
                is_sufficient=available_stock is None or available_stock >= total_qty,
            ))

    print_task_title: str | None = None
    if b.print_task_id:
        if pf is not None:
            print_task_title = pf.task_titles.get(b.print_task_id)
        else:
            from app.models.task import PrintTask
            pt = db.get(PrintTask, b.print_task_id)
            print_task_title = pt.title if pt else None

    assigned_to_name: str | None = None
    if b.assigned_to_id:
        if pf is not None:
            assigned_to_name = pf.user_names.get(b.assigned_to_id)
        else:
            u = db.get(User, b.assigned_to_id)
            assigned_to_name = (u.name or u.email) if u else None

    return BatchOut(
        id=b.id, product_id=b.product_id,
        product_name=p.name if p else "",  # type: ignore[union-attr]
        specification_id=b.specification_id,
        target_qty=b.target_qty, printed_qty=b.printed_qty,
        good_qty=b.good_qty, defect_qty=b.defect_qty,
        status=b.status, priority=b.priority, due_date=b.due_date,
        order_id=b.order_id,
        print_task_id=b.print_task_id,
        print_task_title=print_task_title,
        notes=b.notes,
        components=components,
        assigned_to_id=b.assigned_to_id,
        assigned_to_name=assigned_to_name,
        created_at=b.created_at, updated_at=b.updated_at,
    )

