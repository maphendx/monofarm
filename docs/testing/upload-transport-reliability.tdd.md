# Upload transport reliability — TDD evidence

## User journeys

- As a farm operator, a slow U1 upload keeps the shared agent tunnel connected long enough to finish.
- As a farm operator, a transient Bambu FTPS handshake timeout is retried without replaying a partial `STOR` or disabling certificate verification.
- As a tenant, another organization's agent cannot complete or update my pending upload request.

## RED → GREEN

| Guarantee | RED evidence | GREEN evidence |
|---|---|---|
| Production WebSocket tolerance matches the agent's 120-second tolerance | Startup regression failed because Uvicorn used its 20-second default | Startup regression passes with `WS_PING_TIMEOUT` defaulting to 120 seconds |
| A cancelled/stale job progress callback cannot disconnect the whole agent | Callback exception escaped `handle_agent_message()` | Exception is contained and logged as a sanitized warning |
| Upload responses are scoped to the authenticated organization | A response from org 2 invoked org 1's progress callback | Cross-org response is ignored before callback/future dispatch |
| Bambu FTPS retries Python 3.14 handshake `TimeoutError` | Retry helper was absent | Connect/login receives at most three attempts; `STOR` is never replayed |
| Network timeouts never disable FTPS certificate verification | Two timeouts called the TLS downgrade path | Timeout retries remain on `CERT_REQUIRED`; downgrade logic is not invoked |
| Failed FTPS connect/login attempts release their control socket | Three failed attempts left three partial clients unclosed | Every partial client is closed before the next bounded retry |

## Validation

- Initial RED: 2 backend regressions failed for callback isolation and Uvicorn timeout.
- Initial RED: 2 agent regressions failed because the FTPS retry helper did not exist.
- Security RED: tenant isolation, no-TLS-downgrade, and partial-socket cleanup each failed before the hardened implementation.
- `backend/.venv/bin/pytest -q` — 358 passed before the final security regressions were added; the final focused upload suite passes 23 tests.
- `backend/.venv/bin/ruff check .` — PASS.
- `backend/.venv/bin/pytest -q agent/test_*.py` — 21 passed.
- `bun test` — 57 passed.
- `NEXT_PUBLIC_API_URL=http://localhost:8000 bun run build` — PASS; 53 routes generated.
- `sh -n backend/start.sh` and `git diff --check` — PASS.

## Known gaps

- Hardware FTPS and Moonraker uploads are verified only after the signed Windows agent is published and the farm PC is online.
- Full frontend lint still has unrelated existing warnings/errors documented in the Anycubic hotfix evidence; tests and production build pass.
