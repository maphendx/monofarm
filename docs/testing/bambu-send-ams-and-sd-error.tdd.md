# Bambu send: AMS selection, slot sync, and SD error diagnosis

## Scope

Derived from the attached Bambu A1/P1S send failure report.

## Guarantees

| Behavior | Test | Result |
|---|---|---|
| Printer-level `bambu_has_ams: false` is stored on a queued Bambu job and suppresses `ams_mapping` | `tests/integration/test_files_api.py::test_send_bambu_3mf_uses_printer_ams_setting` | PASS |
| Bambu `0x0500C010` reports an actionable MicroSD message while preserving the raw code | `tests/unit/test_bambu_notifications.py::test_bambu_pause_with_error_emits_failed_alert` | PASS |
| Printer-page slot edits publish Bambu `ams_filament_setting` with Handy-compatible color/RGBA and tray indexes | `tests/unit/test_bambu_lan_payload.py`, `tests/integration/test_slots_api.py::test_bambu_loaded_filaments_sync_to_mqtt` | PASS |
| Existing LAN payload, plate-entry, filename, and profile parsing behavior remains green | `tests/unit/test_bambu_lan_payload.py`, `tests/unit/test_bambu_profile_fetch.py` | PASS |

## Evidence

- RED: the new tests failed because printer-level AMS mode was ignored and the SD error was reported generically.
- GREEN: `python -m pytest tests/unit -q` → 138 passed; focused integration tests → 2 passed.
- Frontend: `bun run build` passed.
- Backend lint: `ruff check` passed for changed backend files.

## Known gaps

- The printer-level mode supports Auto, AMS, and external spool; slot edits drive MQTT synchronization.
- `0x0500C010` is a printer MicroSD fault; the app can explain it but cannot repair the card remotely.
