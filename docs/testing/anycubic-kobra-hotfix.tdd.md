# Anycubic Kobra 3 Max connection hotfix — TDD evidence

## User journey

As a farm operator, I can add an Anycubic Kobra 3 Max by LAN IP from either live printer-management surface, and its local agent telemetry keeps the printer online without allowing another organization or malformed MQTT message to corrupt the connection.

## RED → GREEN

| Guarantee | RED evidence | GREEN evidence |
|---|---|---|
| Both active add-printer wizards expose Anycubic and build a trimmed `anycubic_dev_ip` payload | `cb55475` and `61d052d`: missing wizard export/helper and Anycubic option | Focused wizard and payload regressions pass |
| An unresolved create request cannot be submitted twice, and both edit modals preserve the Anycubic LAN address | `ff19da7`: missing submission guard, edit exports, and edit-IP field | Shared guard and both edit-modal regressions pass |
| Edit mode cannot offer printer-kind changes that the backend would ignore | `85a6427`: kind buttons remained clickable and non-Anycubic updates carried an orphan field | Both edit surfaces disable kind changes; helper regression passes |
| The agent polls both Anycubic printer state and ACE data often enough for the backend freshness window | `9f5b6f1`: missing state poll helper and interval | 14 focused Anycubic agent tests pass |
| Every periodic Anycubic query has a fresh correlation ID | `8442a36`: both query types and all poll cycles reused `msgid=poll` | Consecutive poll requests have disjoint IDs |
| Anycubic telemetry is isolated by organization | `9f5b6f1`: cache API had no organization scope | 8 focused backend tests pass |
| Malformed Anycubic telemetry cannot disconnect the whole farm agent | `de139c4`: parser exception escaped the tunnel handler | Focused tunnel regression passes |
| Anycubic commands carry a current millisecond timestamp, including source-updated agents | `650a941` and `848851d`: generated/default and handler timestamps were absent or `0` | Builder and handler timestamp regressions pass |

## Validation

- `.venv/bin/python -m pytest -q` from `backend/` — 356 passed.
- `.venv/bin/ruff check .` from `backend/` — PASS.
- `backend/.venv/bin/python -m pytest -q agent` — 17 passed.
- Scoped Ruff for all changed Python behavior files — PASS.
- `bun test` — 57 passed.
- Scoped ESLint for the changed frontend files — 0 errors; 8 pre-existing warnings in the duplicated printer managers.
- `NEXT_PUBLIC_API_URL=http://localhost:8000 bun run build` — PASS; 53 routes generated.
- `git diff --check` — PASS.

## CI coverage

The frontend CI job now runs `bun test` before the production build. The backend CI job now also runs the agent test suite, so the Anycubic polling and command regressions gate future merges.

## Existing repository lint notes

Full frontend lint remains blocked by unrelated existing errors in the vendored `BrowserPrint.min.js` and design-system page. Full-repository agent Ruff also reports pre-existing unused imports in `monofarm_tray.py`; the only hotfix change there is the synchronized version string.
