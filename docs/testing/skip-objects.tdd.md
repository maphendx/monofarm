# Skip Objects — TDD evidence

## Scope

- Bambu `.3mf` object IDs and native `skip_objects` MQTT command.
- Shared printer-card / printer-detail selection modal.
- Guard against skipping the last remaining object.

## RED

- `cd backend && .venv/bin/pytest tests/unit/test_skip_objects.py -q`
  - failed during collection: `ModuleNotFoundError: No module named 'app.services.skip_objects'`.
- `cd frontend && bun test src/components/printers/SkipObjectsModal.test.tsx`
  - failed during collection: `Cannot find module './SkipObjectsModal'`.

## GREEN

- Unit contract: Bambu 3MF parsing, last-object guard, MQTT payload, and live
  `s_obj` cache update.
- Frontend contract: bed selection, current/skipped state, empty-state guidance.
- Parsed 3MF geometry is cached for seven days; 1.5-second modal refreshes only
  overlay the lightweight MQTT `s_obj` set.
- `backend/.venv/bin/pytest tests/unit -q`: `168 passed`.
- `backend/.venv/bin/ruff check .`: passed.
- `frontend/bun run build`: production build passed (53 routes).
- Targeted frontend tests: `10 passed`; targeted ESLint has no errors (only
  pre-existing warnings in the printer-detail page).
- The API integration test is present, but the local run requires PostgreSQL on
  `localhost:5432`; Docker/OrbStack was unavailable in this environment.
