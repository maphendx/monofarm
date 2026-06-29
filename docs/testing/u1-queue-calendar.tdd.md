# U1 queue calendar TDD evidence

## Source

Journeys were derived from the user request in this run.

## User journeys

- An operator can drop repeated U1 jobs into the calendar and receive non-overlapping, sequential blocks.
- A sequence that crosses midnight continues at the previous block's end instead of resetting to the original time.
- Starting a planned calendar block opens the existing print dialog with only that block's printer selected.

## Evidence

| Guarantee | Test or command | Result |
| --- | --- | --- |
| Overlapping drops move to the first free interval | `bun test src/components/schedule/utils.test.ts` | PASS |
| Repeated copies are laid out back-to-back | `bun test src/components/schedule/utils.test.ts` | PASS |
| Cross-midnight copies continue at the correct next-day time | `bun test src/components/schedule/utils.test.ts` | PASS |
| Calendar helper coverage | `bun test --coverage src/components/schedule/utils.test.ts` | PASS: 100% functions, 96.91% lines |
| Changed schedule files have no lint errors | `bunx eslint src/components/schedule/...` | PASS: 0 errors, 3 existing image warnings |
| Next.js production compilation and type checking | `bun run build` | PASS |

## RED / GREEN

- RED: the new test target failed because `findSequentialStarts` did not exist.
- GREEN: 13 tests pass after adding interval-aware placement and calendar helper coverage.
- Git checkpoint commits were unavailable because the sandbox denied `.git/index.lock`.

## Known validation gaps

- Authenticated browser verification is pending because no in-app browser tab is connected.
- Backend integration tests require PostgreSQL; Docker/OrbStack was not running.
- Full-project lint still has pre-existing errors in `public/BrowserPrint.min.js` and the design-system page.
