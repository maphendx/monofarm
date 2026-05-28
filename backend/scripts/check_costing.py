"""
Costing cycle diagnostic — read-only baseline check.

Queries the DB and prints:
  - Recent SALE_OUT movements: unit_cost vs unit_price, margin
  - Analytics cash flow direction per movement type
  - Org costing rates

Run: cd backend && python -m scripts.check_costing
"""
from decimal import Decimal

from app.core.db import SessionLocal
from app.models.organization import Organization
from app.models.warehouse import MovementType, WarehouseMovement

SEP = "─" * 60


def fmt(v: Decimal | None) -> str:
    if v is None:
        return "NULL"
    return f"{v:,.2f} ₴"


def pct(rev: Decimal, cost: Decimal) -> str:
    if rev == 0:
        return "n/a"
    return f"{(rev - cost) / rev * 100:.1f}%"


def main() -> None:
    db = SessionLocal()
    try:
        orgs = db.query(Organization).all()
        for org in orgs:
            print(f"\n{SEP}")
            print(f"Org: {org.name} (id={org.id})")
            print(f"  electricity_rate : {getattr(org, 'electricity_rate', 'MISSING')} ₴/кВт·год")
            print(f"  labor_rate       : {getattr(org, 'labor_rate', 'MISSING')} ₴/год")

            # Recent SALE_OUT — check unit_price vs unit_cost
            sales = (
                db.query(WarehouseMovement)
                .filter_by(organization_id=org.id, type=MovementType.SALE_OUT)
                .order_by(WarehouseMovement.created_at.desc())
                .limit(10)
                .all()
            )
            if not sales:
                print("  No SALE_OUT movements yet.")
            else:
                print(f"\n  Last {len(sales)} SALE_OUT movements:")
                print(f"  {'id':>6}  {'qty':>6}  {'unit_cost':>12}  {'unit_price':>12}  {'total_cost':>12}  {'total_revenue':>14}  {'margin':>8}")
                for m in sales:
                    rev  = m.total_revenue or Decimal("0")
                    cost = m.total_cost    or Decimal("0")
                    print(
                        f"  {m.id:>6}  {float(m.quantity):>6.0f}  "
                        f"{fmt(m.unit_cost):>12}  {fmt(m.unit_price):>12}  "
                        f"{fmt(m.total_cost):>12}  {fmt(m.total_revenue):>14}  "
                        f"{pct(rev, cost):>8}"
                    )

            # Cash flow direction per type in this org
            print(f"\n  Cash flow check — movement counts by type:")
            _CF = {
                MovementType.SALE_OUT:       "inflow  (revenue)",
                MovementType.PURCHASE_IN:    "outflow (purchase)",
                MovementType.PRODUCTION_OUT: "outflow (production)",
                MovementType.PRODUCTION_IN:  "ignore  (internal)",
                MovementType.TRANSFER:       "ignore  (internal)",
                MovementType.ADJUSTMENT:     "ignore  (no cash)",
                MovementType.DEFECT:         "ignore  (no cash)",
            }
            for mt, direction in _CF.items():
                count = (
                    db.query(WarehouseMovement)
                    .filter_by(organization_id=org.id, type=mt)
                    .count()
                )
                total_val = (
                    db.query(WarehouseMovement)
                    .filter_by(organization_id=org.id, type=mt)
                    .all()
                )
                if mt == MovementType.SALE_OUT:
                    val = sum(m.total_revenue or m.total_cost or Decimal("0") for m in total_val)
                else:
                    val = sum(m.total_cost or Decimal("0") for m in total_val)
                print(f"    {mt.value:<18} {direction:<28} n={count:>4}  total={fmt(val):>12}")

        print(f"\n{SEP}")
        print("Done. Check 'margin' column — should be > 0 for orders with sale_price > cost_price.")
        print("If unit_price=NULL on old SALE_OUT rows, run the backfill in migration 0034 notes.")

    finally:
        db.close()


if __name__ == "__main__":
    main()
