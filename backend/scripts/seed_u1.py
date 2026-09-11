"""Bulk-create Snapmaker U1 printers (idempotent).

    cd backend && python -m scripts.seed_u1            # creates U1-01..U1-12
    cd backend && python -m scripts.seed_u1 20         # creates U1-01..U1-20
"""
import sys

from app.core.db import SessionLocal
import app.models  # noqa: F401
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.services.bootstrap import seed_admin


def main(count: int = 12) -> None:
    with SessionLocal() as db:
        seed_admin(db)
        org = db.query(Organization).first()
        if not org:
            print("Помилка: не знайдено організацію.")
            return

        created = 0
        for i in range(1, count + 1):
            name = f"U1-{i:02d}"
            if db.query(Printer).filter(Printer.organization_id == org.id, Printer.name == name).first():
                continue
            db.add(Printer(organization_id=org.id, name=name, kind=PrinterKind.snapmaker_u1))
            created += 1
        db.commit()
        print(f"Створено {created} нових U1 принтерів для організації '{org.name}' (всього існує {count}).")



if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    main(n)
