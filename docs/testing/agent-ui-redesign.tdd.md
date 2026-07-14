# Agent UI redesign — TDD evidence

## Source and journeys

Journeys were derived from the task and the live SimplyPrint Client reference at `http://127.0.0.1:8000/`:

- A farm operator can switch between printers, logs, and settings without leaving the local agent UI.
- A farm operator can request an immediate printer discovery refresh and receive the updated shared snapshot.
- A farm operator can search/filter diagnostics and use the UI on a narrow mobile viewport.
- The local agent follows the SimplyPrint Client's utility layout (256 px sidebar, 64 px page bar, primary discovery action, bottom status) without duplicating the main Monofarm application.
- The embedded brand mark matches the pixel mascot geometry from `frontend/public/logo.svg`.

## RED → GREEN

| Guarantee | Test / check | Type | Evidence |
| --- | --- | --- | --- |
| Manual discovery refresh updates the cache and broadcasts the result | `PYTHONPATH=agent python3 -m unittest agent/test_monofarm_tray.py -v` | unit | RED: `_refresh_printers` missing; GREEN: 2 tests passed |
| The local UI exposes printers, logs, settings, log search, and refresh controls | `AgentUiTests.test_ui_exposes_printers_logs_and_settings_views` | contract | RED: required markup missing; GREEN: passed |
| The UI uses the Monofarm brand and SimplyPrint Client placement without generated dashboard metrics | `AgentUiTests.test_ui_uses_monofarm_brand_and_simplyprint_client_layout` | contract | RED: site tokens, client shell, pixel logo, and printer-card contract missing; GREEN: passed |
| All three views are keyboard-addressable and switch correctly | in-app browser DOM snapshots from the isolated preview at `http://127.0.0.1:4757/` | E2E smoke | printers, logs, and settings snapshots matched the active view |
| Sidebar placement matches the local client reference and can collapse | browser comparison against `http://127.0.0.1:8000/printers` | visual / interaction smoke | 256 px sidebar, 64 px topbar, discovery action, navigation, bottom status, and 72 px collapsed state verified |
| Mobile layout remains readable | in-app browser viewport `390x844` | responsive E2E smoke | no horizontal overflow; navigation, settings, printer cards, and empty state remained visible |
| Embedded Python and browser JavaScript load cleanly | `python3 -m py_compile ...`; browser console inspection | syntax / runtime | compile passed; zero browser warnings or errors |

## Coverage and known gaps

The repository has no dedicated JavaScript coverage harness for the stdlib-served agent HTML. The new Python refresh behavior is directly covered, while navigation, filtering surfaces, responsive layout, and browser runtime were checked through focused browser smoke tests. Three Ruff findings in `monofarm_tray.py` predate this change and reproduce against `HEAD`; the new test and changed API file pass Ruff.

Git checkpoint commits could not be created because this workspace exposes `.git` as read-only (`index.lock: Operation not permitted`).
