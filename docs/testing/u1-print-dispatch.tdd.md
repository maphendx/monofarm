# Snapmaker U1 print dispatch TDD evidence

## Scope

The existing Monofarm file-send flow now treats Snapmaker U1 as a kind-aware Moonraker printer:

1. validate the filename and U1 capability;
2. upload without auto-start;
3. apply logical-to-physical head mapping through U1 macros;
4. issue `SDCARD_PRINT_FILE` explicitly;
5. expose `acknowledged` until live telemetry confirms the matching file is printing.

## RED evidence

Added `backend/tests/unit/test_moonraker_dispatch.py` before implementation. The initial run failed during collection because the new dispatch helpers did not exist.

## GREEN evidence

| Guarantee | Test | Result |
|---|---|---|
| U1 mapping emits deterministic logical-to-physical macros | `test_u1_mapping_uses_logical_to_physical_head_macros` | PASS |
| Duplicate physical heads are rejected | `test_u1_mapping_rejects_two_logical_colors_on_one_head` | PASS |
| U1 accepts only gcode-family files | `test_u1_filename_is_basenamed_and_rejects_non_gcode` | PASS |
| Moonraker upload results distinguish started/queued/not-started | `test_upload_result_distinguishes_started_and_queued` | PASS |
| U1 uploads with `print=false`, maps, then explicitly starts without rewriting logical T commands | `test_u1_upload_maps_then_explicitly_starts_without_rewriting_logical_tools` | PASS |
| Existing unit suite remains green | `cd backend && .venv/bin/pytest tests/unit -q` | 114 passed |
| Backend lint remains green | `cd backend && .venv/bin/ruff check .` | PASS |
| Frontend production build remains green | `cd frontend && bun run build` | PASS |
| Agent source compiles | `python3 -m py_compile agent/monofarm_agent.py agent/monofarm_tray.py` | PASS |

## Known verification gaps

- Full integration tests require PostgreSQL on `localhost:5432`; the run produced 126 passed and 132 setup errors because that service was unavailable.
- A live Snapmaker U1 still needs hardware acceptance for the explicit macro/start sequence and the agent upload progress messages.
- Frontend lint has pre-existing errors outside this change; the changed `SendModal.tsx` has no lint errors when checked directly.
- Git checkpoint commits could not be created because the environment denied writing `.git/index.lock`.
