# Send modal live AMS — TDD evidence

## Source and journey

No source plan was provided. The journey was derived from the reported production bug:

> As an operator selecting a file for a Bambu printer, I want the send modal to show the printer's current complete AMS and remap automatically when the AMS changes, without refreshing the page.

## RED → GREEN report

| Guarantee | Test / command | Type | RED evidence | GREEN evidence |
|---|---|---|---|---|
| `/files` keeps its REST fallback only until the first complete printer WebSocket snapshot | `bun test src/lib/printerSlots.test.ts` | Unit | Compile-time RED: `preferRealtimePrinters` export was missing | PASS: realtime snapshot tests pass |
| Print progress does not reset a manual mapping, while an actual AMS material/color change does | `printerSlotStateKey` tests in `src/lib/printerSlots.test.ts` | Unit | Compile-time RED: `printerSlotStateKey` export was missing | PASS: stable for progress, different for AMS change |
| All confirmed AMS trays remain selectable even when the external spool is the current `active_tray` | `bun test src/components/files/SendModal.test.ts` | Unit | Expected `[0, 1, 254]`, received `[254]` | PASS |
| Auto-mapping uses the matching physical AMS tray instead of defaulting to the active external spool | `bun test src/components/files/SendModal.test.ts` | Unit | Expected `{0: 1}`, received `{0: 254}` | PASS |

Focused GREEN command:

```text
bun test src/components/files/SendModal.test.ts src/lib/printerSlots.test.ts
11 pass, 0 fail, 19 expect() calls
```

## Regression validation

- Scoped ESLint for all changed TypeScript files: `0 errors` (existing warnings remain).
- `bun run build`: PASS, 53 routes generated.
- Backend `ruff check .`: PASS.
- Backend `pytest tests/unit -q`: `160 passed`.

## Known repository gaps

- Full `bun test` has one unrelated existing failure in `printerCardModel.test.ts` for Moonraker `canSkipObject`; all new and affected tests pass.
- Full `bun run lint` still reports the repository's pre-existing 8 errors in vendor `BrowserPrint.min.js` and the design-system page. Scoped lint on this change has no errors.
- Separate RED/GREEN checkpoint commits were not created locally because this workspace exposes `.git` metadata read-only. RED and GREEN commands/output are preserved here; the final fix is published as one atomic commit.
