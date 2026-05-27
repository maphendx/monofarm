---
paths:
  - "frontend/src/components/**"
  - "frontend/src/app/**"
---

# Frontend component structure

Components live in subfolders — never in `src/components/` root:

```
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

**Before creating a new component:**
1. Check the list above — it may already exist.
2. Check `globals.css` for reusable CSS classes: `.btn`, `.badge`, `.input`, `.surface`, `.ds-table`, `.printer-card`, `.nav-link` and others — prefer these over new components.
3. If creating: pick the right subfolder. New printer UI → `printers/`, shared modal wrapper → `ui/`, page layout → `layout/`.

**Import path pattern:** always `@/components/<subfolder>/<Component>` — never `@/components/<Component>` (flat imports are broken after the 2026-05-27 reorganization).

**Design tokens:** use `var(--*)` CSS variables from `globals.css`. Never raw Tailwind palette (`bg-blue-500`, `text-emerald-400`) or hex literals in layout/state code. Key tokens: `--accent`, `--text`, `--text-muted`, `--text-faint`, `--bg`, `--bg-elevated`, `--surface-hi`, `--border`, `--border-strong`, `--state-print`, `--state-ok`, `--state-idle`, `--state-warn`, `--state-error`, `--state-offline`.
