# Print transfer overlay auto-dismiss — TDD evidence

## Source

The user clarified that the target is the global print-transfer overlay rendered above every app window, not the upload button on `/files`.

## User journey

As a Monofarm operator, I want the global file-transfer overlay to remain visible while the transfer is active and disappear 3–4 seconds after completion or failure, so finished notifications do not obstruct the app.

## Task report

- Changed the existing global `PrintTransferStatus` terminal-state timer from 8000 ms to 3500 ms.
- The overlay becomes dismissible when the printer acknowledges the file or starts printing, even while the backend job remains active.
- The dismiss effect depends only on stable job IDs, so once-per-second print-progress updates do not restart its timer.
- RED: the first run failed because `PRINT_TRANSFER_DISMISS_MS` was missing; the progress regression run failed because `getPrintTransferDismissKey` was missing.
- GREEN: `bun test src/lib/printTransferStore.test.ts` passed all 5 tests after the timer and stable dismiss-key contracts were implemented.

## Test specification

| # | What is guaranteed | Test | Type | Result |
|---|---|---|---|---|
| 1 | Terminal transfer overlays use a 3500 ms dismiss delay | `dismisses terminal transfer overlays within four seconds` | Unit | PASS |
| 2 | Acknowledged and printing jobs start the overlay dismiss timer | `starts dismissing after the printer accepts the file or starts printing` | Unit | PASS |
| 3 | Print-progress changes do not restart the dismiss timer | `does not restart the dismiss timer when print progress changes` | Unit | PASS |
| 4 | Active queued transfers remain tracked after the send modal closes | `keeps a queued print visible after the send modal closes` | Unit | PASS |
| 5 | Active transfers remain restorable after page reload | `persists active transfers so a page reload can restore them` | Unit | PASS |

## Coverage and known gaps

The repository has no React DOM test dependency. The timer value and transfer-store lifecycle are unit tested; scoped ESLint and the Next.js production build validate the component wiring.

## Merge evidence

RED and GREEN evidence is preserved here because the shared worktree contains unrelated in-progress changes and no isolated checkpoint commits were created.
