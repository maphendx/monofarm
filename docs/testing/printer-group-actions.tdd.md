# Printer group actions TDD evidence

## Source

User journey derived from the SimplyPrint “Actions for group” reference screenshot.

## User journey

As a farm administrator, I can run one confirmed action for a printer group so that every eligible printer is updated consistently, unsupported printers are reported as skipped, and maintenance creates a real farm task.

## RED → GREEN

| Guarantee | Test/evidence | RED | GREEN |
| --- | --- | --- | --- |
| Out-of-order affects only printers in the selected tenant group | `test_group_action_marks_only_group_printers_out_of_order` | `404 Not Found` | PASS |
| Maintenance creates a persisted `FarmTask` with group context | `test_group_action_creates_real_maintenance_task` | `404 Not Found` | PASS |
| AutoPrint updates eligible A1 Mini printers and reports unsupported models | `test_group_action_enables_autoprint_and_reports_skipped_printers` | `404 Not Found` | PASS |
| Group menu exposes confirm, maintenance, and AutoPrint flows | Playwright interaction at `/dashboard` | trigger absent | PASS |
| Narrow viewport keeps the action sheet inside the viewport | Playwright at `390×844` | trigger absent | PASS |

## Validation

- `cd backend && . .venv/bin/activate && ruff check . && pytest -q`
  - PASS: `251 passed`
- Targeted frontend ESLint for the changed components
  - PASS: no errors
- `cd frontend && bun run build`
  - PASS: production build and TypeScript
- Full frontend lint
  - Existing repository baseline remains: `8 errors, 189 warnings`; no errors are in the changed files.
- Desktop browser flow
  - PASS: exact bulk payloads for `mark_out_of_order`, `create_maintenance`, and `enable_autoprint`
  - PASS: unsupported scheduled-maintenance and AI actions are visibly disabled
  - PASS: no page errors or framework overlay
- Mobile browser flow
  - PASS: action sheet fits within `390×844` without clipping

## Coverage and known gaps

The repository has no frontend unit/E2E test script or coverage command. Backend behavior is covered by integration tests; rendered behavior was validated with isolated Playwright API responses. Scheduled-maintenance group linkage and an AI failure-detection engine do not exist yet, so those controls intentionally remain disabled instead of presenting non-functional actions.
