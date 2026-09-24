# Material workflow

- Receive spools from Materials or Warehouse → Product → Stock. Select the warehouse material (grams or kilograms), warehouse, material/color, spool weight/count and optional price per kilogram. One PURCHASE_IN creates all physical spools. The UI retains a request ID for retries; a repeated receipt does not add stock again.
- Assign a physical spool to a printer slot. Empty/retired spools and spools already assigned elsewhere are rejected by the slot assignment endpoint. Loading/unloading does not change warehouse quantities.
- Dispatch freezes plate-specific planned grams, physical slot mapping, spool IDs and spool costs in `BambuCloudJob.request_payload_json.material_plan`. Preflight and reservations use that same mapping, including Bambu external slot 254. The organization policy controls blocking; insufficient reservations are never created.
- Finalization deducts once using the captured spool, and writes material WRITE_OFF from its warehouse. Cost and planned demand do not change after editing the library file or swapping a spool before a delayed completion notification. A Bambu progress value of 1 means 1%, not completion. Bambu partial consumption remains an estimate based on progress.
- “Update remaining weight” takes the net filament weight (without the empty spool). A single transaction records the spool correction and warehouse ADJUSTMENT. A stale correction cannot overwrite a newer print deduction. Zero weight marks the spool empty.
- Warehouse → Product → Stock shows its spools, printer locations and available grams. Material movements and the spool journal link to the exact history run. Visible material/stock views refresh every 15 seconds.

## Data and compatibility

Migration 0096 adds `Filament.warehouse_id`, `receipt_id` and `PrintHistory.material_plan`. Existing linked spools receive a warehouse automatically only when the product has stock at exactly one warehouse; ambiguous locations are not guessed. New receipts always capture their location. Warehouse units g/г and kg/кг are converted explicitly.

Unlinked legacy spools continue to work as spool-only inventory. Historical runs without a material snapshot retain the legacy fallback. Tracking a physical spool replacement halfway through a running print is not segmented automatically. Warehouse shortages are logged and clamped, as before, and remain visible in material reconciliation. This implementation does not provide RFID or automatic weighing.

## Verification

`backend/tests/integration/test_spool_workflow.py` covers receipt replay and conflicts, kg pricing, atomic corrections, precise warehouse selection, remapped reservations, immutable spool/file identity, 1% cancellation, reservation shortage enforcement, retired spools and migration upgrade/downgrade.
