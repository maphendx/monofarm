# Bambu AMS assignment ACK — TDD evidence

## User journey

As a farm operator, I want a color or inventory assignment made in Monofarm to be accepted by the physical Bambu printer and appear in Handy immediately, without the next MQTT snapshot reverting the UI.

## RED → GREEN

| Guarantee | Test | RED evidence | GREEN evidence |
|---|---|---|---|
| The command matches current Bambu Studio fields and carries a real generic filament profile | `test_ams_filament_setting_uses_local_tray_index_and_rgba_color` and external/empty variants | `KeyError: 'slot_id'`; profile and temperature fields were absent | PASS |
| A successful printer ACK updates the shared AMS cache before the WebSocket refresh | `test_successful_filament_ack_updates_ams_cache_before_refresh` | cache remained `[]` after `result=success` | PASS |
| Only physical slots whose material state changed are sent to the printer | `test_bambu_loaded_filaments_only_sends_changed_slots` | the endpoint sent the complete slot list | Pending local PostgreSQL; covered by CI |
| A rejected or timed-out Bambu command cannot be committed as a successful DB assignment | `test_bambu_loaded_filaments_are_not_persisted_without_printer_ack` | the endpoint committed before MQTT publish/ACK | Pending local PostgreSQL; covered by CI |

## Validation

- `backend/.venv/bin/ruff check .` — PASS.
- `backend/.venv/bin/pytest tests/unit -q` — 161 passed.
- Focused Bambu payload and realtime suite — 29 passed.
- `bun test src/components/printers/PrinterAmsOverview.test.tsx src/lib/printerSlots.test.ts` — 10 passed.
- Scoped printer-page ESLint — 0 errors; 5 pre-existing warnings.
- `bun run build` — PASS, 53 routes generated.

## Environment note

The focused slot API integration suite requires PostgreSQL at `localhost:5432`. The local Docker daemon was unavailable, so CI's PostgreSQL service is the required integration gate before deployment. The full frontend lint remains blocked by 8 unrelated pre-existing errors in vendor `BrowserPrint.min.js` and the design-system page.
