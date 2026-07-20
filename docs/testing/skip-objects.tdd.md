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

## Large-file delayed-start regression

- Journey: a Bambu print started from Monofarm must retain its source 3MF even
  when a long upload causes the dispatch job to time out before the printer
  begins reporting `RUNNING`.
- Production evidence: live Bambu printers were reporting `printing` while the
  matching Monofarm job had become `failed`; the filename and `gcode_file_id`
  were still intact.
- RED selector test: `pytest tests/unit/test_skip_objects.py -q` failed during
  collection because `select_bambu_source_job` did not exist.
- RED disk-backed parser test: the parser raised `TypeError` when given a 3MF
  path, proving that the previous path required the whole file in memory.
- GREEN: matching `failed` or `lost` jobs are recoverable for seven days only
  when their normalized filename exactly matches the live Bambu print.
- GREEN: S3-backed 3MF files are downloaded to a temporary file and parsed from
  disk, avoiding a second full-file RAM allocation for large files.
- `backend/.venv/bin/pytest tests/unit/test_skip_objects.py -q`: `8 passed`.
- `backend/.venv/bin/ruff check app/services/skip_objects.py app/api/printers.py tests/unit/test_skip_objects.py tests/integration/test_bambu_skip_objects.py`: passed.
- The parameterized API regression covers both `failed` and `lost`.
- GitHub CI: `345 passed`; PostgreSQL integration tests and Alembic migration
  verification passed.
- Production read-only verification: active Bambu A3 resolved its matching
  `failed` Monofarm job, parsed a `49,898,116` byte 3MF from disk, and returned
  `18` selectable objects with `available=true` and `source=bambu_mqtt`.
