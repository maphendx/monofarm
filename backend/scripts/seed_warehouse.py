"""Seed warehouse module with demo data (idempotent on warehouses/products by name)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from decimal import Decimal
from app.core.db import SessionLocal
from app.models.warehouse import (
    BatchStatus, MovementType, Order, OrderItem, OrderStatus, OrderSource,
    ProductionBatch, SpecComponent, SpecOperation, SpecOpType, Specification,
    StockEntry, Warehouse, WarehouseMovement, WarehouseType, Product,
)
from app.models.organization import Organization

def get_or_create_wh(db, org_id, name, wtype, location=""):
    row = db.query(Warehouse).filter_by(organization_id=org_id, name=name).first()
    if not row:
        row = Warehouse(organization_id=org_id, name=name, type=wtype, location=location)
        db.add(row)
        db.flush()
    return row

def get_or_create_product(db, org_id, user_id, name, sku, categories, sale_price):
    row = db.query(Product).filter_by(organization_id=org_id, sku=sku).first()
    if not row:
        row = Product(
            organization_id=org_id, created_by_id=user_id,
            name=name, sku=sku, categories=categories, unit="шт",
            sale_price=Decimal(str(sale_price)),
        )
        db.add(row)
        db.flush()
    return row

def seed_spec(db, product_id, components, operations):
    existing = db.query(Specification).filter_by(product_id=product_id, is_default=True).first()
    if existing:
        return existing
    spec = Specification(product_id=product_id, name="Основна", version=1, is_default=True)
    db.add(spec)
    db.flush()
    for i, c in enumerate(components):
        db.add(SpecComponent(specification_id=spec.id, sort_order=i, **c))
    for i, op in enumerate(operations):
        db.add(SpecOperation(specification_id=spec.id, sort_order=i, **op))
    return spec

def add_stock(db, org_id, product_id, warehouse_id, qty):
    row = db.query(StockEntry).filter_by(product_id=product_id, warehouse_id=warehouse_id).first()
    if not row:
        db.add(StockEntry(organization_id=org_id, product_id=product_id, warehouse_id=warehouse_id, quantity=Decimal(str(qty))))
    elif row.quantity == 0:
        row.quantity = Decimal(str(qty))

def main():
    db = SessionLocal()
    try:
        org = db.query(Organization).first()
        if not org:
            print("No organization found"); return
        from app.models.user import User
        admin = db.query(User).filter_by(organization_id=org.id).first()
        uid = admin.id if admin else None

        # Warehouses
        wh_fin = get_or_create_wh(db, org.id, "Готова продукція", WarehouseType.finished, "Полиця A")
        wh_raw = get_or_create_wh(db, org.id, "Сировина",         WarehouseType.raw,      "Полиця B–C")
        wh_bad = get_or_create_wh(db, org.id, "Брак",             WarehouseType.defect,   "Полиця D")

        # Products
        products_data = [
            ("Птеродактиль Keychain", "PTERO-KC-001", ["Іграшки", "Cute"], 120,
             [{"name":"PLA Black (Bambu)", "quantity":Decimal("4.2"), "unit":"g", "unit_price":Decimal("0.20"), "waste_pct":Decimal("5")}],
             [{"type":SpecOpType.print,  "name":"Друк (AMS)",           "print_time_min":Decimal("45"), "power_watts":220, "labor_minutes":Decimal("2")},
              {"type":SpecOpType.manual, "name":"Видалення підтримок",   "labor_minutes":Decimal("5")}],
             34),
            ("Rocket Stand", "RKET-ST-002", ["Декор"], 280,
             [{"name":"PLA White (eSun)", "quantity":Decimal("18.5"), "unit":"g", "unit_price":Decimal("0.18"), "waste_pct":Decimal("3")}],
             [{"type":SpecOpType.print, "name":"Друк", "print_time_min":Decimal("120"), "power_watts":200}],
             12),
            ("Phone Holder Flex", "PHON-HLD-003", ["Аксесуари"], 350,
             [{"name":"PETG Transparent", "quantity":Decimal("24.0"), "unit":"g", "unit_price":Decimal("0.22"), "waste_pct":Decimal("4")}],
             [{"type":SpecOpType.print, "name":"Друк", "print_time_min":Decimal("90"),  "power_watts":200},
              {"type":SpecOpType.postprocess, "name":"Покраска", "explicit_cost":Decimal("2.0")}],
             5),
            ("Cube Stand v2", "CUBE-ST-004", ["Декор"], 480,
             [{"name":"PLA Black (Bambu)", "quantity":Decimal("42.0"), "unit":"g", "unit_price":Decimal("0.20"), "waste_pct":Decimal("5")}],
             [{"type":SpecOpType.print, "name":"Друк", "print_time_min":Decimal("180"), "power_watts":220}],
             0),
            ("Dragon Mini", "DRAG-MN-005", ["Іграшки"], 650,
             [{"name":"PLA Black (Bambu)", "quantity":Decimal("65.0"), "unit":"g", "unit_price":Decimal("0.20"), "waste_pct":Decimal("5")}],
             [{"type":SpecOpType.print, "name":"Друк", "print_time_min":Decimal("210"), "power_watts":220},
              {"type":SpecOpType.manual,"name":"Збірка і упаковка", "labor_minutes":Decimal("10")}],
             8),
        ]

        for name, sku, cats, price, comps, ops, stock_qty in products_data:
            p = get_or_create_product(db, org.id, uid, name, sku, cats, price)
            seed_spec(db, p.id, comps, ops)
            add_stock(db, org.id, p.id, wh_fin.id, stock_qty)

        # Production batches
        p1 = db.query(Product).filter_by(organization_id=org.id, sku="PTERO-KC-001").first()
        p4 = db.query(Product).filter_by(organization_id=org.id, sku="CUBE-ST-004").first()
        p2 = db.query(Product).filter_by(organization_id=org.id, sku="RKET-ST-002").first()

        if p1 and not db.query(ProductionBatch).filter_by(organization_id=org.id, product_id=p1.id, status=BatchStatus.active).first():
            db.add(ProductionBatch(organization_id=org.id, created_by_id=uid, product_id=p1.id, target_qty=100, printed_qty=78, good_qty=75, status=BatchStatus.active))
        if p4 and not db.query(ProductionBatch).filter_by(organization_id=org.id, product_id=p4.id, status=BatchStatus.active).first():
            db.add(ProductionBatch(organization_id=org.id, created_by_id=uid, product_id=p4.id, target_qty=50, printed_qty=23, good_qty=22, status=BatchStatus.active))
        if p2 and not db.query(ProductionBatch).filter_by(organization_id=org.id, product_id=p2.id, status=BatchStatus.draft).first():
            db.add(ProductionBatch(organization_id=org.id, created_by_id=uid, product_id=p2.id, target_qty=30, status=BatchStatus.draft))

        # Sample movements
        if p1 and not db.query(WarehouseMovement).filter_by(organization_id=org.id).first():
            for m in [
                dict(type=MovementType.PRODUCTION_IN,  product_id=p1.id, warehouse_to_id=wh_fin.id, quantity=Decimal("20"), unit="шт"),
                dict(type=MovementType.PURCHASE_IN,     product_id=p1.id, warehouse_to_id=wh_raw.id, quantity=Decimal("2000"), unit="г", unit_cost=Decimal("0.20")),
            ]:
                db.add(WarehouseMovement(organization_id=org.id, created_by_id=uid, **m))

        # Sample order
        if not db.query(Order).filter_by(organization_id=org.id).first():
            o = Order(organization_id=org.id, created_by_id=uid, order_number="#ORD-0001",
                      customer_name="Олег Петренко", source=OrderSource.manual,
                      status=OrderStatus.in_production, total_amount=Decimal("1200"), currency="UAH")
            db.add(o)
            db.flush()
            if p1:
                db.add(OrderItem(order_id=o.id, product_id=p1.id, quantity=10, unit_price=Decimal("120"), total_price=Decimal("1200")))

        db.commit()
        print("✓ Warehouse seed complete")
        print(f"  Warehouses: {db.query(Warehouse).filter_by(organization_id=org.id).count()}")
        print(f"  Products:   {db.query(Product).filter_by(organization_id=org.id).count()}")
        print(f"  Batches:    {db.query(ProductionBatch).filter_by(organization_id=org.id).count()}")
        print(f"  Orders:     {db.query(Order).filter_by(organization_id=org.id).count()}")
    finally:
        db.close()

if __name__ == "__main__":
    main()
