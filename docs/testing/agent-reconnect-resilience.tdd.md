# Agent reconnect resilience — TDD evidence

## Source and user journey

The journey was derived from the production incident on 2026-07-14:

> As a farm operator, I can connect or reconnect a protocol-v2 farm agent with multiple U1 printers without making the Monofarm API unresponsive, so file upload and print dispatch remain available.

## Task report

### RED

Command:

```text
cd backend
. .venv/bin/activate
pytest tests/unit/test_tunnel_device_connectivity.py tests/unit/test_print_tracker.py -q
```

Result before the fix: `3 failed, 5 passed`.

- Two reconnects started two simultaneous history backfills.
- Synchronous v2 target authorization completed before the event loop could tick.
- Synchronous Moonraker history persistence completed before the event loop could tick.

### GREEN

The same command after the fix returned `8 passed`.

Broader verification:

```text
cd backend
. .venv/bin/activate
ruff check .
pytest tests/unit -q
```

Result: `All checks passed!` and `226 passed`.

The selected tunnel/upload suite returned `23 passed` before DB-backed integration setup. Local integration setup could not open `localhost:5432` because the execution sandbox denied loopback TCP with `Operation not permitted`; CI remains the authoritative integration gate.

## Test specification

| # | What is guaranteed | Test | Type | Result |
|---|---|---|---|---|
| 1 | A same-device reconnect leaves only one active delayed history backfill | `test_same_device_reconnect_keeps_only_one_history_backfill` | Unit/concurrency | PASS |
| 2 | A slow v2 device/printer authorization query does not block the API event loop | `test_v2_target_authorization_does_not_block_the_event_loop` | Unit/concurrency | PASS |
| 3 | Slow Moonraker history persistence does not block the API event loop | `test_history_backfill_persistence_does_not_block_the_event_loop` | Unit/concurrency | PASS |
| 4 | Existing tunnel upload, stream backpressure, cache isolation and device connectivity behavior remains green | backend unit suite | Unit/regression | PASS |

## Coverage and known gaps

The changed branches are directly exercised by the three regression tests. No standalone percentage report was generated. DB-backed integration tests require CI or another environment that permits access to the test PostgreSQL service.

## Merge evidence

- RED: `3 failed, 5 passed` on the focused reproducer command.
- GREEN: `8 passed` on the same command.
- Regression: `ruff` clean and `226 passed` in the full backend unit suite.
