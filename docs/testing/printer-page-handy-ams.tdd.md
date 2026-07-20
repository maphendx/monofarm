# Printer page Handy AMS — TDD evidence

## Source and journey

The requested operator journey is on the existing `/printers/[id]` page:

> As a Bambu operator, I want the printer page to present AMS-A trays and the external spool like Bambu Handy, while keeping the camera secondary and compact.

The existing WebSocket printer stream and filament assignment endpoints remain the source of truth; this change only recomposes their presentation.

## RED → GREEN report

| Guarantee | Test / command | Type | RED evidence | GREEN evidence |
|---|---|---|---|---|
| The printer page AMS view renders `AMS-A`, `A1`, empty, external, active, and reel states | `bun test src/components/printers/PrinterAmsOverview.test.tsx` | Component SSR | Failed to resolve `./PrinterAmsOverview` because the view did not exist | `1 pass`, `0 fail`, `7 expect()` calls |
| The new view preserves the established live-slot normalization and send-modal mapping behavior | `bun test src/components/printers/PrinterAmsOverview.test.tsx src/components/files/SendModal.test.ts src/lib/printerSlots.test.ts` | Regression | Not applicable | `13 pass`, `0 fail`, `31 expect()` calls |
| The printer detail route compiles with the compact camera and new AMS component | `bun run build` | Production build | Not applicable | PASS, 53 routes generated |

## Validation notes

- Scoped ESLint on the three changed frontend files: `0 errors` (6 existing warnings remain in the large printer page).
- Full `bun run lint` remains blocked by 8 pre-existing errors in vendor `BrowserPrint.min.js` and the design-system page.
- Separate RED/GREEN checkpoint commits were not created locally because this workspace exposes `.git` metadata read-only. Command evidence is preserved here and the finished change is published atomically.
