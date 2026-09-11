# Warehouse API architecture

`backend/app/api/warehouse.py` is a small compatibility facade. It composes the
public and paid-plan routers in their original registration order and re-exports
`_apply_movement` and `_update_avco` for the existing print-task integration.
Endpoint code lives under `backend/app/api/warehouse_modules/`:

| Module | Responsibility |
| --- | --- |
| `notice.py` | Organization notice and SSE stream |
| `catalog.py` | Categories and scanner lookup |
| `products.py` | Product CRUD, archive, import/export, images |
| `specifications.py` | BOM, operations, costing, Ordage import/export |
| `locations.py` | Warehouses, zones, cells, putaway and relocation |
| `stock.py` | Stock views, replenishment and stock import/export |
| `movements.py` | Immutable movement ledger and cursor pagination |
| `production.py` | Production batch lifecycle |
| `assembly.py` | Assembly sessions and worker statistics |
| `orders.py` | Sales-order reservation, shipment and payments |
| `counterparties.py` | Suppliers and customers |
| `purchases.py` | Purchase receiving and POS sales |
| `finance.py` | Cash flow and analytics |
| `settings.py` | Bank accounts and label templates |
| `stocktakes.py` | Inventory count lifecycle and invoices |
| `reports.py` | Pick lists, reconciliation, reversal and reports |
| `common.py` | Shared stock, AVCO, bin and serialization invariants |
| `batch_serialization.py` | Batched production response prefetching |
| `pagination.py` | Shared offset and limit bounds |

Domain routers depend on models, schemas, `common.py`, and `pagination.py`; they
do not import other domain routers. Shared batch response construction is kept in
`batch_serialization.py`, so assembly and production remain independently
importable.

Large collection routes accept `skip` and `limit`. The default page contains 100
rows and the maximum is 500. Every paginated query orders by its business sort
key plus a unique `id` tie-breaker. The movement ledger retains cursor pagination
because writes can arrive continuously while an operator browses it.

The response body remains a JSON array for API compatibility. Frontend screens
that require a complete collection use `apiAll()` from `frontend/src/lib/api.ts`;
it preserves existing filters and walks the API in bounded 500-row pages.
