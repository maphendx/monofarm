# PlateCycler Cloud AutoPrint — TDD evidence

## Source

Journeys were derived from the requested Bambu A1 Mini + Chitu PlateCycler flow and the existing Monofarm AutoPrint implementation.

## User journeys

- As a farm operator, I can enable PlateCycler AutoPrint on an A1 Mini connected through Bambu Cloud without enabling LAN Only Mode.
- As a farm operator, I can queue files with repeat counts and have Monofarm prepare each 3MF, print it, then continue with the next run.
- As a farm operator, I can see the current file, copy number, remaining copies, loaded plates, and next files directly on the printer page.
- As a LAN-only operator, I still receive a clear validation error when local IP and Access Code are missing.

## Task report

- RED: `.venv/bin/pytest -q tests/unit/test_platecycler_3mf.py tests/integration/test_platecycler_autoprint.py` failed during collection because cloud dispatch had no PlateCycler file-preparation path; the existing integration expectation also required LAN credentials in cloud mode.
- GREEN: the same target passed with `15 passed`; after adding the LAN-only regression, the affected backend set passed with 33 tests.
- Full validation: `.venv/bin/ruff check . && .venv/bin/pytest -q` completed with `All checks passed` and `301 passed`.
- UI RED: the printer-scoped status endpoint returned `404` and the frontend AutoPrint summary module did not exist.
- UI GREEN: `test_autoprint_status_returns_current_copy_and_printer_queue` passed; the Bun view-model target passed `2 tests / 8 assertions`; `next build` completed successfully.
- The repository-wide frontend lint remains blocked by pre-existing errors in `public/BrowserPrint.min.js` and the design-system page. ESLint on the changed AutoPrint files passes.

## Test specification

| # | What is guaranteed | Test target | Type | Result |
|---|---|---|---|---|
| 1 | Cloud-mode A1 Mini AutoPrint does not require LAN IP or Access Code | `test_autoprint_cloud_mode_does_not_require_ip_or_access_code` | integration | PASS |
| 2 | Explicit LAN mode still requires local credentials | `test_autoprint_explicit_lan_mode_still_requires_local_credentials` | integration | PASS |
| 3 | Cloud dispatch injects cooling, delay, and PlateCycler swap G-code before upload | `test_cloud_dispatch_prepares_platecycler_3mf_before_upload` | unit | PASS |
| 4 | Repeated runs are counted idempotently and queue advancement remains intact | existing AutoPrint integration/unit targets | integration/unit | PASS |
| 5 | The printer page receives the active copy and only this printer's current-day queue | `test_autoprint_status_returns_current_copy_and_printer_queue` | integration | PASS |
| 6 | The operator summary calculates current copy, remaining workload, file count, and plate shortage | `autoPrintModel.test.ts` | unit | PASS |

## Coverage and known gaps

The repository does not currently include a pytest coverage plugin or configured coverage command, so a percentage was not available. The full 301-test backend suite passed. Live printing on physical A1 Mini + C1M hardware remains the final external verification step.
