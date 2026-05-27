---
paths:
  - "frontend/**/*.tsx"
  - "frontend/**/*.ts"
---

# Frontend (Next.js)

Long-form context stays in root `CLAUDE.md`. When editing under `frontend/`:

- **Tooling**: Bun; **Tailwind v4** in `app/globals.css` — **restart** `bun run dev` after changing that file.
- **API client**: `src/lib/api.ts` — inject JWT from storage; **omit** `Content-Type: application/json` for `FormData` bodies.
- **Dark mode**: class-based `.dark` (see layout script in `CLAUDE.md`).
- **Reuse before creating**: before writing a new component, check `src/components/` and `src/components/ui/`. Existing: `Modal`, `Topbar`, `Sidebar`, `PrinterCard`, `StateIcon`, `FilamentSwatches`, `ThemeToggle`, `SendModal`, `StartPrintModal`, `DashboardPet`, `Icon` (ui/). Use CSS classes from `globals.css` (`.btn`, `.badge`, `.input`, `.surface`, `.ds-table`, `.printer-card`, `.nav-link`, etc.) instead of one-off Tailwind before reaching for a new component.
- **Always use design tokens**: colors, spacing, radii must come from `var(--*)` tokens defined in `globals.css` `:root`. Never use raw Tailwind palette utilities (`bg-blue-500`, `text-emerald-400`, `border-red-300`, etc.) or hex literals in layout/state code. Token reference: `--accent`, `--text`, `--text-muted`, `--text-faint`, `--bg`, `--bg-elevated`, `--surface-hi`, `--border`, `--border-strong`, `--state-print`, `--state-ok`, `--state-idle`, `--state-warn`, `--state-error`, `--state-offline`. Exception: intentional art SVGs (mascot, spool, manufacturer brand colors).
