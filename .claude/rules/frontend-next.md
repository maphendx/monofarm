---
paths:
  - "frontend/**/*.tsx"
  - "frontend/**/*.ts"
---

# Frontend (Next.js)

Long-form context in root `CLAUDE.md`. When editing under `frontend/`:

## Tooling

- Bun; **Tailwind v4** in `app/globals.css` — **restart** `bun run dev` after changing that file (hot reload does not pick up `@custom-variant` changes).
- Check types: `bun run build` — catches TypeScript errors before runtime.

## API client

`src/lib/api.ts` — `api<T>(path, init?)` injects JWT from localStorage, throws `ApiError` on non-2xx. **Omit** `Content-Type: application/json` for `FormData` bodies (browser sets multipart boundary automatically).

## Dark mode

Class-based `.dark` applied before hydration via inline script in `app/layout.tsx`. Use `dark:` variant in Tailwind. Never use `prefers-color-scheme` media query.

## Design tokens — mandatory

Colors, spacing, radii must come from `var(--*)` CSS variables defined in `globals.css :root`. **Never** use raw Tailwind palette utilities (`bg-blue-500`, `text-emerald-400`, `border-red-300`) or hex literals in layout/state code.

Key tokens:

```text
--accent            primary action color
--text              body text
--text-muted        secondary text
--text-faint        disabled / placeholder
--bg                page background
--bg-elevated       cards, dropdowns
--surface-hi        highlighted surface
--border            default border
--border-strong     emphasized border
--state-print       actively printing (blue)
--state-ok          success / done (green)
--state-idle        idle (gray)
--state-warn        warning (yellow)
--state-error       error (red)
--state-offline     offline (muted)
```

Exception: intentional art SVGs (mascot, spool, manufacturer brand colors).

## Component structure — subfolders, never flat

```text
ui/           Modal, ThemeToggle, DynamicFavicon, Icon
layout/       Sidebar, Topbar
printers/     PrinterCard, PrinterDetailModal, PrinterGroupsModal, PrintersManager,
              StartPrintModal, StateIcon, CreatePrinterModal
dashboard/    DashboardPet, DaySummary
filament/     FilamentSwatches
files/        SendModal
users/        TelegramLinkModal
labels/       LabelGeneratorModal, LabelPreview
plan/         CreateTaskModal, PrinterDropZone, TaskQueueItem
queue/        AmountStepper
warehouse/    CloseBatchModal, CreateBatchModal, MovementModal
```

Import pattern: `@/components/<subfolder>/<Component>` — flat `@/components/<Component>` is broken.

## Reuse before creating

Before writing a new component:

1. Check the list above.
2. Check `globals.css` for CSS classes: `.btn`, `.badge`, `.input`, `.surface`, `.ds-table`, `.printer-card`, `.nav-link` — prefer these over new components.
3. If truly new: pick the right subfolder based on domain.

## Double-submit guard

Use `useRef` inFlight guard for actions that call the API (not `useState` — state updates are async and don't prevent re-entry within the same render cycle):

```tsx
const inFlight = useRef(false);
async function handleAction() {
  if (inFlight.current) return;
  inFlight.current = true;
  try { await api(...) } finally { inFlight.current = false; }
}
```
