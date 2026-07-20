# U1 realtime colors TDD evidence

## Source and journey

The journey was derived from the production issue reported on 2026-07-20:
an operator must see the four colors reported by every Snapmaker U1 immediately,
without opening another application or refreshing the Monofarm page.

## Task report

- Production evidence showed that all 11 U1 printers had complete
  `u1_filaments` snapshots under Redis keys without a trailing slash, while the
  printer rows used Moonraker URLs with a trailing slash.
- RED: `.venv/bin/pytest tests/unit/test_u1_realtime_sync.py -q` executed three
  regressions and failed all three for the intended cache/realtime gaps.
- GREEN: `.venv/bin/pytest tests/unit/test_u1_realtime_sync.py tests/unit/test_u1_slots.py tests/unit/test_ws_printer_events.py -q`
  passed `7` tests.
- Regression: `. .venv/bin/activate && pytest tests/unit -q` passed `164` tests.
- Static checks: `ruff check .` passed and `bun run build` completed successfully.
- Screenshot follow-up RED: `bun test src/lib/printerSlots.test.ts` failed because
  the U1 page had no printer-first display adapter and rendered only persistent
  `printer.slots`.
- Screenshot follow-up GREEN: the same target passed `10` tests after the U1
  display switched to normalized live slots; `bun run build` passed again.
- Dashboard follow-up RED: the focused printer-card test failed at compile time
  because no card-source selector existed and the card unconditionally preferred
  persistent DB slots for every non-Bambu printer.
- Dashboard follow-up GREEN: the focused printer-card test passed after only
  generic/manual printers kept the editable DB-slot strip; U1 cards now render
  normalized live slots from the same WebSocket snapshot as the printer page.

## Test specification

| # | What is guaranteed | Test | Type | Result |
|---|---|---|---|---|
| 1 | A DB URL ending in `/` reads the agent snapshot stored under the canonical Moonraker URL | `test_cached_status_matches_agent_url_without_trailing_slash` | unit | PASS |
| 2 | A status packet without `print_task_config` cannot erase the last complete U1 colors | `test_status_push_keeps_last_u1_colors_when_packet_is_incomplete` | unit | PASS |
| 3 | A real U1 slot change immediately broadcasts a fresh printer snapshot to open browsers | `test_u1_color_change_pushes_fresh_printer_snapshot` | unit | PASS |
| 4 | The U1 printer page shows live printer colors even when its persistent inventory slots are empty | `renders U1 printer colors even when persistent inventory slots are empty` | unit | PASS |
| 5 | A U1 dashboard card cannot hide live colors behind four empty persistent DB slots | `uses live U1 filament presentation even when persistent slots exist` | unit | PASS |

## Coverage and known gaps

No repository coverage command is configured. The complete backend unit suite
passed. Local integration tests could not connect to PostgreSQL on
`localhost:5432`; CI supplies PostgreSQL and remains the integration gate.
Frontend lint still reports pre-existing errors in `BrowserPrint.min.js` and
the design-system page, while the production build succeeds.

The RED checkpoint commit could not be created locally because this execution
environment denied writes to `.git/index.lock`; the RED output above was
captured before any production-code change.
