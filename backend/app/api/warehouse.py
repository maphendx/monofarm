"""Warehouse/ERP API composed from independent domain routers.

Business invariants shared across domains live in ``warehouse_modules.common``.
The re-exports keep the established imports used by print-task completion code.
"""

from fastapi import APIRouter

from app.api.warehouse_modules import (
    assembly,
    catalog,
    counterparties,
    finance,
    locations,
    movements,
    notice,
    orders,
    production,
    products,
    purchases,
    reports,
    settings,
    specifications,
    stock,
    stocktakes,
)
from app.api.warehouse_modules.common import _apply_movement, _update_avco

router = APIRouter(prefix="/warehouse")

# Preserve the original registration order: routes on the public router came
# first, followed by the paid-plan router. Starlette matching is order-sensitive.
_DOMAIN_ROUTERS = (
    notice,
    catalog,
    locations,
    counterparties,
    products,
    specifications,
    stock,
    movements,
    production,
    assembly,
    orders,
    finance,
    settings,
    purchases,
    stocktakes,
    reports,
)

for domain in _DOMAIN_ROUTERS:
    router.include_router(domain.public_router)

for domain in _DOMAIN_ROUTERS:
    router.include_router(domain.full_router)

__all__ = ["_apply_movement", "_update_avco", "router"]
