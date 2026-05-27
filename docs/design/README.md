# Handoff: Monofarm Design System v1.0 — Full Codebase Integration

## ⚡ TL;DR for Claude Code

You are integrating a finalized, Linear-quality design system across **the entire Monofarm codebase** at 100% fidelity. The design system has three modules — **web app**, **desktop agent**, **warehouse** — that all share one visual language.

**The single source of truth for every visual decision is `Monofarm Design System.html` in this folder.** When uncertain, open it and look. Do not invent colors, spacing, or type values that aren't already there.

This is not a redesign of "the dashboard". This is a system-wide refit. Every page, every component, every state must match.

---

## What you're getting

| File | What it is |
|---|---|
| `Monofarm Design System.html` | The canonical design reference. Open in browser. Contains every token, component, applied example, and motion spec. |
| `tokens.css` | Ready-to-paste Tailwind v4 token block — drop into `globals.css`. |
| `README.md` | This file. |

---

## Project context (you already have access to this repo)

- **Repo root**: `monofarm/`
- **Frontend**: `monofarm/frontend/` — Next.js 15 (App Router) + Tailwind v4 + TypeScript + Bun
- **Backend**: `monofarm/backend/` — leave styling out of scope unless serving HTML
- **Desktop agent**: `monofarm/agent/` — local helper app (apply design system here too — section 9 of the HTML)
- **Existing styles**: `monofarm/frontend/src/app/globals.css` — replace tokens block with the new one
- **Existing components**: `monofarm/frontend/src/components/` — refit, do not delete and rebuild from scratch

---

## Brand fundamentals (memorize these)

| Token | Dark | Light |
|---|---|---|
| Background | `#0a0a0b` | `#f7f7f6` |
| Surface | `#141416` | `#ffffff` |
| Border | `rgba(255,255,255,.06)` | `rgba(0,0,0,.07)` |
| Text (high) | `#ffffff` | `#09090b` |
| Text (default) | `#ededed` | `#18181b` |
| Text (muted) | `#a1a1aa` | `#52525b` |
| **Accent** | `#22d3ee` (cyan-400) | `#0891b2` (cyan-600) |

**Printer states** (semantic, do not use decoratively):
- `printing` → `#38bdf8` (dark) / `#0284c7` (light)
- `ready` → `#22c55e` / `#16a34a`
- `idle` → `#a3a3a3` / `#71717a`
- `paused/warn` → `#f59e0b` / `#d97706`
- `error` → `#ef4444` / `#dc2626`
- `offline` → `#52525b` / `#a1a1aa`

**Fonts**:
- Sans: `"IBM Plex Sans", system-ui, sans-serif` — feature settings `"ss01", "cv11"`
- Mono: `"IBM Plex Mono", ui-monospace, monospace` — feature setting `"zero"`

**Logo**:
- Mark = 3×3 grid of outlined dots with a filled center dot (the "Farm Grid")
- See `Monofarm Design System.html` → section 1.0 for SVG source + scale/clearspace/misuse rules
- Replace any existing logo SVG in `frontend/src/components/Sidebar.tsx`, favicons in `frontend/public/`, and agent app icon

---

## Step-by-step integration plan

### Phase 1 · Foundations (do these first, do not skip)

1. **Replace `frontend/src/app/globals.css`** with the contents of `tokens.css` in this folder. Keeps `@import "tailwindcss"` and `@custom-variant dark`. Add the `:root`, `.dark`, and `@theme inline` blocks.
2. **Wire up IBM Plex fonts** via `next/font/google`:
   ```ts
   // frontend/src/app/layout.tsx
   import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
   const sans = IBM_Plex_Sans({ subsets: ["latin", "cyrillic"], weight: ["300","400","500","600","700"], variable: "--font-sans" });
   const mono = IBM_Plex_Mono({ subsets: ["latin", "cyrillic"], weight: ["400","500","600"], variable: "--font-mono" });
   ```
   Apply `${sans.variable} ${mono.variable}` to `<html>`. Set body `font-family: var(--font-sans)`.
3. **Default to dark mode**. Add `class="dark"` to `<html>` in `layout.tsx`. Light is secondary.
4. **Replace the logo** in `Sidebar.tsx` with the Farm Grid SVG (find it in section 1.0 of the HTML).
5. **Generate favicons** from the Farm Grid mark — 16, 32, 48, 64, 128, 256 PNGs + an ICO. Replace `frontend/public/favicon.ico` and add `<link>` tags to `layout.tsx`.

### Phase 2 · Primitive components

Create / refit these in `frontend/src/components/ui/`:

| Component | Reference section | Key specs |
|---|---|---|
| `Button` | 7.1 | 4 variants (primary/secondary/ghost/danger) × 3 sizes (sm 26px / md 32px / lg 38px); `btn-shimmer` adds top highlight; focus ring = 3px var(--accent-ring) |
| `Input` / `Select` / `Textarea` | 7.2 | 34px height, `--r-sm` radius, `--border-strong` border, focus = `--border-focus` + ring |
| `Checkbox` / `Radio` / `Toggle` | 7.2 | 16px box, 4px radius checkbox / circle radio / 32×18 toggle |
| `Card` / `Surface` | 7.3 | `var(--surface)` bg with subtle `linear-gradient(180deg, rgba(255,255,255,.025), transparent 40%)` ledge; `--r-lg` radius; `--border` |
| `Badge` | 7.4 | Status (printing/ready/warn/error/offline) + Neutral + Accent. Mono uppercase 10.5px, `--r-xs`, soft-tint bg + 20% border |
| `Table` | 7.5 | Mono uppercase 10.5px headers, 12.5–13px body, hover highlight, mono numbers right-aligned |
| `Modal` | 7.6 | `--bg-elevated`, `--border-strong`, `--r-xl`, `--shadow-lg`, scale .96→1 + fade in 240ms ease-out |
| `Toast` | 7.6 | Stacks bottom-right, type-mapped icon colors (success/info/error), fade+rise enter 160ms ease-out |
| `Skeleton` | 7.7 | Shimmer 1.6s ease-in-out infinite, surface-hi base |
| `Progress` | 7.3 (used in printer card) | 4px tall, state-colored fill |

### Phase 3 · Iconography

- Use **lucide-react** for line icons (matches our 24×24 / 1.6 stroke / round caps spec exactly)
- Set defaults: `<Icon strokeWidth={1.6} />` everywhere
- For Monofarm-specific marks (the Farm Grid logo, mascot, printer-state dots), inline as SVG components

### Phase 4 · Applied components

| Component | Reference | File |
|---|---|---|
| Printer card (6 states) | 8.1 | `frontend/src/components/PrinterCard.tsx` |
| Sidebar | 8.2 + section nav of HTML | `frontend/src/components/Sidebar.tsx` |
| Topbar | 8.2 | `frontend/src/components/Topbar.tsx` |
| Stat strip | 7.3 (hero of HTML) | `frontend/src/components/StatStrip.tsx` |
| Empty state | 7.7 | with mascot pixel art (section 1.0 / mascot subsection) |

### Phase 5 · Pages

Refit these to use the new system:
- `app/(app)/dashboard/page.tsx` — match the hero product moment in the HTML's hero
- `app/(app)/warehouse/page.tsx` — match section **10.0** of HTML exactly. Spreadsheet-dense, sticky SKU column, mass-edit toolbar, color dots, margin colored green
- `app/login/page.tsx`, `app/register/page.tsx`, `app/onboarding/page.tsx` — apply tokens, type scale, dark-first
- `app/(app)/printers/[id]/page.tsx` — full printer detail (extend printer card patterns)

### Phase 6 · Desktop agent (`monofarm/agent/`)

Apply the **same** tokens, fonts, and components. The agent is **not** a different brand — it's the same Monofarm, just running locally. See section **9.0** of HTML:
- Native window chrome (don't reinvent macOS traffic lights / Windows title bar)
- Sidebar with Cloud sync / Printers / LAN discovery / Diagnostics
- Live event stream (mono table, 11.5px, color-coded SYNC OK / UPLOAD / WS RETRY / DISCOVER)
- Tray icon: 4 states (idle / printing pulsing cyan / alert with red dot / disconnected)
- Tray dropdown popover: 280px width, sorted by urgency

### Phase 7 · Motion

Adopt the motion tokens from section **5.0**:
- `--dur-instant: 80ms` — hover, click feedback
- `--dur-quick: 160ms` — dropdowns, tooltips, toasts
- `--dur-base: 240ms` — modals, sidebar
- `--dur-slow: 400ms` — page transitions only
- `--ease-out: cubic-bezier(.16, 1, .3, 1)` (default)
- `--ease-in-out: cubic-bezier(.65, 0, .35, 1)`
- `--ease-spring: cubic-bezier(.34, 1.56, .64, 1)` (delight moments only)

**Always honor `prefers-reduced-motion`** — drop transitions to `.01ms`.

---

## Critical rules (do not break)

1. **No magic numbers.** Every spacing/radius/color must come from a token. If you find yourself typing `padding: 14px;` — find the nearest token (`--s-3 = 12px` or `--s-4 = 16px`).
2. **No new colors.** If a state isn't covered by the existing semantic colors, don't invent one — flag it and ask.
3. **State colors carry meaning.** Don't use `var(--state-error)` for non-error content. Don't use `var(--state-print)` for non-printing content. Use `--accent` for neutral emphasis.
4. **Mono font is for labels, numbers, IDs, file names** — anything technical. Do not use Plex Mono for body copy.
5. **Border-defines-surface in dark mode.** Use `1px solid var(--border)` instead of drop shadows for card separation. Shadows are reserved for floating elements (modals, popovers, toasts).
6. **Density matters.** Warehouse rows = 36–40px tall. Dashboard cards = compact. Don't pad like a marketing site.
7. **Preserve `data-comment-anchor` attributes** if you find any in existing markup — they pin review comments.
8. **The mascot (Mono)** is real brand IP. Keep its pixel scale rules (integer multiples only, `image-rendering: pixelated`). Use in empty states + as a floating dashboard companion. See HTML mascot subsection.

---

## Acceptance criteria

A refit is at 100% when:

- [ ] Every page uses tokens from `tokens.css` exclusively
- [ ] No hex colors in component files (everything is `var(--*)` or Tailwind theme reference)
- [ ] IBM Plex Sans + Mono loaded via `next/font`, with Cyrillic subset (Ukrainian UI text)
- [ ] Logo replaced everywhere: sidebar, favicons, agent app icon, login page, browser tab title
- [ ] Dark mode is the default; light is opt-in toggle in user settings
- [ ] All 6 printer states render correctly with the state-colored top border + dot + status text + correct empty-state copy
- [ ] Sidebar matches section 8.2 — collapsed 56–64px wide, icon-only, brand at top
- [ ] Stat strip matches the hero of the HTML — 5–6 columns, mono uppercase eyebrows, big number, state-colored bottom bar
- [ ] Warehouse table matches section 10.2 — sticky SKU column, 12-column layout, color dots, mono right-aligned numbers, mass-edit toolbar
- [ ] Desktop agent matches section 9.0 — native chrome, same tokens, live event stream
- [ ] Tray icon implements 4 states with the cyan-pulse animation on printing
- [ ] `prefers-reduced-motion` respected everywhere
- [ ] No console errors, no a11y warnings (run `next lint`)
- [ ] Bun build passes
- [ ] Lighthouse: contrast ≥ AA on every text/bg combination

---

## Workflow suggestion for you, Claude Code

```
1. Read this README end-to-end.
2. Open Monofarm Design System.html in a browser. Click through every section.
3. Replace globals.css → run `bun run dev` → confirm tokens apply.
4. Build the primitive component layer (Phase 2) — all 10 components, with all states.
5. Build a /design-system route in the app that imports every primitive — your visual regression target.
6. Refit page-by-page, starting with the dashboard.
7. Verify against the HTML mock at each step. When in doubt — match the HTML.
```

---

## When in doubt

The HTML file is the **single source of truth**. If this README says X and the HTML shows Y — the HTML wins. The README is a roadmap; the HTML is the spec.

Don't ship something that "looks roughly like" the design. Ship something that **is** the design.
