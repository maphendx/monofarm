---
paths:
  - "backend/app/api/warehouse.py"
  - "backend/app/api/warehouse_modules/**/*.py"
  - "backend/app/models/warehouse.py"
  - "backend/app/schemas/warehouse.py"
  - "frontend/src/app/**/warehouse/**"
  - "frontend/src/components/warehouse/**"
---

# Warehouse / ERP module

Long-form context in root `CLAUDE.md`. Rules specific to warehouse code:

## Router structure and pagination

`api/warehouse.py` is only the public compatibility facade and router aggregator.
Put endpoints in the matching domain module under `api/warehouse_modules/`; shared
stock/cost invariants stay in `common.py`. Large list routes use the shared
`PageOffset` / `PageLimit` bounds from `pagination.py`, with stable tie-breaker
ordering. Frontend views that need the complete collection use `apiAll()` so they
walk bounded pages instead of relying on an unbounded response.

## Stock ledger — never mutate directly

All stock changes go through `_apply_movement(movement, db)` — it updates `StockEntry.quantity` and `reserved_qty`. Never write to `StockEntry` directly outside this function.

Movement types and when to use them:
- `PURCHASE_IN` — goods received from supplier
- `SALE_OUT` — shipped to customer (decrements both quantity and reserved_qty)
- `RETURN_IN` — customer return
- `TRANSFER` — between warehouses
- `ADJUSTMENT` — manual correction
- `PRODUCTION_IN` — output of a closed batch (finished goods)
- `PRODUCTION_OUT` — components consumed by a closed batch
- `WRITE_OFF` — spoilage / loss

## AVCO cost tracking

`_apply_movement(movement, db)` owns AVCO updates for incoming PURCHASE_IN / PRODUCTION_IN movements: it invokes `_update_avco` before changing stock. Supply the movement’s `unit_cost`; do not call `_update_avco` again in the caller, because that would apply the weighted average twice.

## Auto-replenish

`_check_and_auto_replenish(pid, org_id, db)` fires after SALE_OUT and PRODUCTION_OUT. Opens a new `ProductionBatch` when `available_qty < reorder_point` and a default spec exists. Do not call it after ADJUSTMENT or manual movements.

## Order state machine

`new` → `reserved` (reserve endpoint, locks `reserved_qty`) → `shipped` (ship endpoint, writes SALE_OUT movements and releases reservation) → `cancelled` (cancel endpoint, releases reserved_qty without movement).
Never skip states. Shipping a non-reserved order will raise 400.

## Production batch state machine

`draft` → `open` (create batch) → `closed` (close batch — writes PRODUCTION_IN for output qty and PRODUCTION_OUT for each spec component). Closing is irreversible.

## Warehouse enums — use the existing values

```python
MovementType:    PURCHASE_IN, SALE_OUT, RETURN_IN, TRANSFER, ADJUSTMENT, PRODUCTION_IN, PRODUCTION_OUT, WRITE_OFF
BatchStatus:     draft, open, closed
OrderStatus:     new, reserved, shipped, cancelled
OrderSource:     manual, keycrm
WarehouseType:   physical, virtual, consignment
CounterpartyType: supplier, customer
SpecOpType:      cut, sew, print, pack, other
CashTxType:      income, expense
```

## KeyCRM webhook

Endpoint: `POST /api/keycrm/webhook/{org_slug}`. Validates `X-KeyCRM-Signature: sha256=<hex>` HMAC. Creates/updates `Order` + `OrderItem`. The org must have `keycrm_webhook_secret` set. Do not bypass signature validation.

## Frontend warehouse components

Reuse `CloseBatchModal`, `CreateBatchModal`, `MovementModal` from `src/components/warehouse/`. Check these before creating new modals. Use `Modal` from `src/components/ui/Modal` as the base wrapper.
