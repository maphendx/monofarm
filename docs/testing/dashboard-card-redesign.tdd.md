# Dashboard printer card redesign TDD evidence

## Source

User journey derived from the approved Figma reference and the dashboard card requirements.

## User journeys

As a farm operator, I can read a printer's state, temperatures, loaded slots, current job, progress, and finish time from one compact dashboard card.

As an operator, I can open the camera, pause/stop/skip when supported, confirm bed clearing, and open the printer details without losing the existing actions.

## RED → GREEN

| Guarantee | Test/evidence | RED | GREEN |
| --- | --- | --- | --- |
| Printer states map to the visual card themes | `printerCardModel.test.ts` | missing `printerCardModel` module | PASS |
| ETA and absolute finish time format correctly | `printerCardModel.test.ts` | missing `printerCardModel` module | PASS |
| Slot numbers stay one-based in the UI | `printerCardModel.test.ts` | missing `printerCardModel` module | PASS |
| Skip is limited to active Moonraker prints | `printerCardModel.test.ts` | missing `printerCardModel` module | PASS |
| Known printer models resolve to assets and unknown models use a placeholder | `printerCardModel.test.ts` | missing `printerCardModel` module | PASS |

## Validation

- `cd frontend && bun test src/components/printers/printerCardModel.test.ts`
  - PASS: `5 pass`, `0 fail`
- Targeted ESLint for the changed frontend files
  - PASS: `0 errors`; existing warnings remain in dashboard/SlotStrip hooks and image usage
- `cd frontend && bun run build`
  - PASS: production build and TypeScript
- `git diff --check`
  - PASS: no whitespace errors
- Full frontend lint
  - Existing repository baseline remains: errors in `public/BrowserPrint.min.js` and `design-system/page.tsx`; no errors are in the changed card implementation.

## Coverage and known gaps

The repository has no frontend coverage command or component/E2E test setup. Pure card rules are covered; rendered visual states still require browser review at 320/768/1440px and in both themes. The active-job thumbnail currently uses the existing `last_gcode_file_id` when a job is present because the dashboard printer payload does not expose a separate active file id.
