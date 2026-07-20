# Bambu AMS realtime sync — TDD evidence

## User journey

As a farm operator, I want AMS colors and inventory assignments to update in Monofarm without opening the printer in Bambu Handy, so every open dashboard stays synchronized with the printer.

## RED → GREEN

| Guarantee | Test | RED evidence | GREEN evidence |
|---|---|---|---|
| A full Bambu `pushall` request contains `sequence_id`, `version`, and `push_target` | `test_bulk_filament_sync_requests_fresh_printer_report` | `KeyError: 'version'` | PASS |
| A partial external-spool report does not erase known AMS trays | `test_partial_external_report_preserves_last_full_ams` | received `[254]`, expected `[0, 254]` | PASS |
| An authoritative empty AMS list clears disconnected trays | `test_authoritative_empty_ams_report_clears_stale_slots` | returned `False` and retained stale slots | PASS |
| AMS cache lives beyond the five-minute full refresh cadence | `test_ams_cache_outlives_periodic_full_refresh` | constants missing | PASS |
| Existing devices receive periodic full-state requests | `test_subscription_refresh_requests_full_status_for_existing_devices` | no refresh was requested | PASS |
| Partial Bambu reports retain missing local assignments but reject mismatched spools | `printerSlots.test.ts` | missing assigned slot; mismatched assignment retained | PASS |

## Validation

- `backend/.venv/bin/ruff check .` — PASS.
- `backend/.venv/bin/pytest tests/unit -q` — 160 passed.
- `bun test src/lib/printerSlots.test.ts` — 6 passed.
- Scoped frontend ESLint — 0 errors; pre-existing warnings remain in the printer page.
- `bun run build` — PASS, 53 pages generated.

## Known gap

The focused slot API integration suite requires PostgreSQL at `localhost:5432`; it could not start locally because that service was unavailable. The repository CI provides PostgreSQL and is the integration gate before deployment.
