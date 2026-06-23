# Monofarm Frontend — Agent Context

This file is the single source of truth for any AI model (Claude Code, Codex, Copilot, Cursor, etc.) working on the monofarm frontend. Read this before writing any code.

## What is monofarm

Multi-tenant 3D print farm management SaaS. Each customer gets an isolated Organization with printers, files, filaments, users, warehouse/ERP. The frontend is the operator dashboard — live printer monitoring, task/plan management, filament inventory, file library, and a full warehouse module (products, stock, orders, production batches, cash flow).

## Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router) | 16.x |
| React | React | 19.x |
| Language | TypeScript | 5.x |
| CSS | Tailwind CSS v4 | 4.x |
| Package manager | Bun | latest |
| Icons | lucide-react | |
| Drag & drop | @dnd-kit | |
| Charts | recharts | |
| Toasts | sonner | |
| Barcodes | jsbarcode, react-qr-code | |
| Fonts | IBM Plex Sans, IBM Plex Mono (Google Fonts, via next/font) | |

## Commands

```bash
bun install          # install dependencies
bun run dev          # dev server on :3000
bun run build        # production build (also type-checks)
bun run lint         # eslint
```

## CRITICAL: Next.js 16 breaking changes

This project runs Next.js 16, which has breaking changes from what you may know. **Before writing any code that touches Next.js APIs, routing, or configuration, read the relevant guide in `node_modules/next/dist/docs/`**. Do not rely on training data — APIs, conventions, and file structure may differ.

## Project structure

```
frontend/
├── src/
│   ├── app/                    # Next.js App Router pages
│   │   ├── globals.css         # Design tokens + component CSS classes
│   │   ├── layout.tsx          # Root layout (fonts, theme script, providers)
│   │   ├── (app)/              # Authenticated app shell (sidebar + main)
│   │   │   ├── layout.tsx      # Auth check, sidebar, search, scanner
│   │   │   ├── dashboard/      # Live printer grid
│   │   │   ├── printers/       # Printer list + /[id] detail
│   │   │   ├── tasks/          # Print task kanban
│   │   │   ├── plan/           # Daily print plan (drag-and-drop)
│   │   │   ├── queue/          # Print queue
│   │   │   ├── files/          # Gcode/3mf file library
│   │   │   ├── filament/       # Filament inventory
│   │   │   ├── history/        # Print history log
│   │   │   ├── analytics/      # Charts and stats
│   │   │   ├── schedule/       # Calendar/schedule view
│   │   │   ├── users/          # User management
│   │   │   ├── settings/       # Org settings, billing, API keys
│   │   │   ├── support/        # Support page
│   │   │   ├── warehouse/      # Full ERP module (see below)
│   │   │   └── ...
│   │   ├── login/              # Auth pages (public)
│   │   ├── register/
│   │   ├── admin/              # Platform admin panel
│   │   └── ...
│   ├── components/             # Reusable components (subfolder-organized)
│   │   ├── ui/                 # Modal, ThemeToggle, DynamicFavicon, Icon, SearchModal, etc.
│   │   ├── layout/             # Sidebar, Topbar, ImpersonationBanner
│   │   ├── printers/           # PrinterCard, PrinterDetailModal, StartPrintModal, etc.
│   │   ├── dashboard/          # DashboardPet, DaySummary, FlowView
│   │   ├── filament/           # FilamentSwatches
│   │   ├── files/              # SendModal, AutoDispatchModal
│   │   ├── users/              # TelegramLinkModal, UsersSection
│   │   ├── labels/             # LabelGeneratorModal, LabelPreview
│   │   ├── plan/               # CreateTaskModal, PrinterDropZone, TaskQueueItem
│   │   ├── queue/              # AmountStepper
│   │   ├── schedule/           # ScheduleCalendar, ScheduleBacklog, ScheduleJobBlock
│   │   ├── warehouse/          # MovementModal, ScannerModal, SpecModal, LabelCanvas, etc.
│   │   └── legal/              # LegalPage
│   └── lib/                    # Shared utilities
│       ├── api.ts              # API client (see below)
│       ├── auth-context.tsx    # useUser() hook via React Context
│       ├── i18n.tsx            # Ukrainian/English i18n (useT hook)
│       ├── types.ts            # All TypeScript interfaces/types
│       ├── format.ts           # Formatting helpers
│       ├── search.ts           # Search utilities
│       ├── impersonation.tsx   # Admin impersonation context
│       ├── impersonation-store.ts
│       ├── adminApi.ts         # Admin panel API client
│       ├── printerLabels.ts    # Printer label generation
│       ├── printerSetupData.ts # Printer setup constants
│       ├── usePageTitle.ts     # Page title hook
│       └── translations/       # en.ts, uk.ts translation files
├── public/                     # Static assets, favicons
├── package.json
├── tsconfig.json
├── next.config.ts              # Minimal (empty config)
└── Dockerfile                  # Multi-stage bun build
```

## Warehouse module routes

The warehouse is a full ERP layer under `(app)/warehouse/`:

| Route | Purpose |
|-------|---------|
| `/warehouse` | Dashboard |
| `/warehouse/products` | Product catalog |
| `/warehouse/products/[id]` | Product detail + specifications |
| `/warehouse/stock` | Stock levels per warehouse |
| `/warehouse/movements` | Stock movement ledger |
| `/warehouse/orders` | Order management |
| `/warehouse/production` | Production batches |
| `/warehouse/assembly` | Assembly view |
| `/warehouse/categories` | Product categories |
| `/warehouse/counterparties` | Suppliers/customers |
| `/warehouse/cashflow` | Cash flow transactions |
| `/warehouse/cashregister` | Cash register |
| `/warehouse/warehouses` | Warehouse CRUD |
| `/warehouse/warehouses/[id]` | Zones/cells/stock |
| `/warehouse/specs` | Specification library |
| `/warehouse/analytics` | Warehouse analytics |
| `/warehouse/labels` | Product label generation |
| `/warehouse/purchases` | Purchase management |
| `/warehouse/bank-accounts` | Bank accounts |
| `/warehouse/zones` | Zone management |

## API client

`src/lib/api.ts` exports `api<T>(path, init?)`:

- Injects JWT from `localStorage` (key: `monofarm_token`)
- Throws `ApiError` on non-2xx responses
- Auto-clears token on 401
- Skips `Content-Type: application/json` for `FormData` (browser sets multipart boundary)
- Supports admin impersonation via `X-Impersonated-Org-Id` header
- Backend base URL: `NEXT_PUBLIC_API_URL` env var (defaults to `http://localhost:8000`)

```typescript
import { api, ApiError } from "@/lib/api";

// GET
const printers = await api<Printer[]>("/api/printers");

// POST
const task = await api<PrintTask>("/api/tasks/print", {
  method: "POST",
  body: JSON.stringify({ title: "Test", quantity: 1 }),
});

// FormData upload (no JSON content-type)
const formData = new FormData();
formData.append("file", file);
await api("/api/files", { method: "POST", body: formData });
```

All backend API endpoints are mounted under `/api`. Key routers: `/api/auth`, `/api/printers`, `/api/tasks/print`, `/api/tasks/farm`, `/api/plan`, `/api/files`, `/api/filaments`, `/api/warehouse`, `/api/analytics`, `/api/billing`.

## Authentication

- JWT stored in `localStorage` (key: `monofarm_token`)
- `useUser()` hook from `src/lib/auth-context.tsx` provides current user inside `(app)/` routes
- `(app)/layout.tsx` checks token on mount, fetches `/api/auth/me`, redirects to `/login` if 401
- Platform admins are redirected to `/admin` unless impersonating an org
- Shows `MascotLoader` until auth check completes
- User roles: `admin`, `operator`, `manager`
- Org plans: `free`, `starter`, `pro`, `farm`

## i18n

Two locales: `uk` (Ukrainian, default) and `en` (English). Use the `useT()` hook:

```typescript
const t = useT();
return <h1>{t("nav.dashboard")}</h1>;
```

Translation files: `src/lib/translations/en.ts` and `uk.ts`. The `t()` function accepts dot-path keys that are type-safe via `TKey` type. When adding new UI text, add keys to **both** translation files.

## Design tokens — MANDATORY

All colors, spacing, and radii come from CSS custom properties in `globals.css`. **Never use raw Tailwind palette classes** (`bg-blue-500`, `text-emerald-400`) or hex literals in layout/state code.

### Key tokens

| Token | Purpose |
|-------|---------|
| `--accent` | Primary action color (cyan) |
| `--text` | Body text |
| `--text-hi` | High-emphasis text |
| `--text-muted` | Secondary text |
| `--text-faint` | Disabled/placeholder |
| `--text-dim` | Very faint text |
| `--bg` | Page background |
| `--bg-elevated` | Cards, dropdowns, modals |
| `--surface` | Component background |
| `--surface-2` | Subtle surface variant |
| `--surface-hi` | Highlighted surface |
| `--border` | Default border |
| `--border-strong` | Emphasized border |
| `--border-focus` | Focus ring border |
| `--accent-soft` | Accent background tint |
| `--accent-ring` | Accent focus ring |
| `--state-print` | Printing state (blue) |
| `--state-ok` | Success/done (green) |
| `--state-idle` | Idle (gray) |
| `--state-warn` | Warning (yellow) |
| `--state-error` | Error (red) |
| `--state-offline` | Offline (muted) |
| `--state-production` | Production (purple) |
| `--r-xs` to `--r-full` | Border radii |
| `--s-0` to `--s-16` | Spacing scale (2px ramp) |
| `--dur-instant`, `--dur-quick`, `--dur-base`, `--dur-slow` | Animation durations |
| `--ease-out`, `--ease-in-out`, `--ease-spring` | Easing curves |
| `--shadow-sm`, `--shadow-md`, `--shadow-lg` | Shadows |

Tailwind bridge: the `@theme inline` block in `globals.css` maps tokens to Tailwind classes. You can use `bg-accent`, `text-text-muted`, `border-border`, `rounded-lg`, etc.

### Dark mode

Class-based `.dark` on `<html>`. Applied before hydration via inline script in `layout.tsx` (reads `localStorage` key `monofarm_theme`). Default theme is **dark**. Use `dark:` Tailwind variant. **Never use `prefers-color-scheme` media query.**

### Tailwind v4 caveat

Tailwind v4 uses `@custom-variant dark` in `globals.css`. **The dev server must be restarted after any change to `globals.css`** — hot reload does not pick up `@custom-variant` changes.

## Component CSS classes

`globals.css` defines reusable CSS classes. **Check these before creating new components:**

| Class | Purpose |
|-------|---------|
| `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-warn` | Buttons (32px height, variants) |
| `.btn-sm`, `.btn-lg`, `.btn-icon` | Button sizes |
| `.badge`, `.badge-neutral`, `.badge-accent`, `.badge-print`, `.badge-ok`, `.badge-warn`, `.badge-error` | Status badges |
| `.surface` | Card surface with subtle gradient |
| `.input`, `.select`, `.select-field`, `.textarea-field` | Form inputs |
| `.ds-table`, `.table` | Data tables (two styles) |
| `.table-wrap` | Table container with border/radius |
| `.modal-panel`, `.modal-head`, `.modal-title`, `.modal-sub`, `.modal-actions` | Modal layout |
| `.printer-card`, `.printer-card.printing`, `.printer-card.error`, `.printer-card.ok`, `.printer-card.warn` | Printer card states |
| `.nav-link`, `.nav-link.active` | Sidebar navigation |
| `.empty`, `.empty-icon`, `.empty-title`, `.empty-sub` | Empty state |
| `.progress`, `.progress-fill` | Progress bars |
| `.skeleton` | Loading skeleton with shimmer |
| `.field`, `.field-label`, `.field-hint` | Form field wrappers |
| `.check-row`, `.toggle` | Checkboxes/toggles |
| `.badge-dot` | Status dot badges |
| `.demo-stat`, `.demo-stat-label`, `.demo-stat-value` | Stat cards |
| `.toast-item` | Toast notifications |

## Component organization rules

1. Components live in **subfolders** under `src/components/` — never in the root
2. Import path: `@/components/<subfolder>/<Component>` — flat `@/components/<Component>` does not work
3. Before creating a new component, check if one already exists in the subfolder list or if a CSS class in `globals.css` covers the need
4. Place new components in the subfolder matching their domain: printer UI → `printers/`, shared modal → `ui/`, warehouse → `warehouse/`

## Key types

All types live in `src/lib/types.ts`. Key interfaces:

| Type | Fields |
|------|--------|
| `User` | `id`, `email`, `name`, `role` (admin/operator/manager), `org_plan`, `telegram_chat_id`, `allowed_modules` |
| `Printer` | `id`, `name`, `kind` (snapmaker_u1/bambu/other), `state`, `job`, `progress_pct`, `slots`, `loaded_filaments`, `flags`, temps, `tags` |
| `PrintTask` | `id`, `title`, `quantity`, `status` (queued/in_progress/done/cancelled), `filament_meta`, `product_id`, cost fields, `tags` |
| `Filament` | `id`, `material`, `color`, `hex_color`, `brand`, `grams_remaining`, `cost_per_kg`, `is_low` |
| `GcodeFile` | `id`, `original_name`, `filament_meta`, `has_thumbnail`, `folder_id`, `tags` |
| `PlanEntry` | printer-task-date join, scheduling fields (`schedule_mode`, `start_time`, `priority`, `conflict`) |
| `BambuCloudJob` | job dispatch lifecycle for Bambu Lab printers (queued → uploading → printing → completed/failed) |
| `CalendarLane` / `CalendarDay` | Schedule calendar types with printer grouping |
| `PrinterGroup` | `id`, `name`, `color`, build dimensions, `supported_materials` |
| `FilamentSlot` | Per-slot filament info (slot index, color, type, brand) |

### Enums (string literal unions)

- `UserRole`: `"admin" | "operator" | "manager"`
- `OrgPlan`: `"free" | "starter" | "pro" | "farm"`
- `PrinterKind`: `"snapmaker_u1" | "bambu" | "other"`
- `PrintTaskStatus`: `"queued" | "in_progress" | "done" | "cancelled"`
- `FarmTaskStatus`: `"todo" | "in_progress" | "done"`
- `ScheduleMode`: `"asap" | "not_before" | "exact_time" | "window"`

## Patterns and conventions

### Double-submit guard

Use `useRef` for in-flight guards (not `useState` — state updates are async and don't prevent re-entry):

```tsx
const inFlight = useRef(false);
async function handleAction() {
  if (inFlight.current) return;
  inFlight.current = true;
  try { await api(...); } finally { inFlight.current = false; }
}
```

### Slot indexing

0-based everywhere in code and API. UI displays 1-based — convert at render time only.

### Printer states

Unified vocabulary: `idle`, `printing`, `paused`, `operational`, `error`, `offline`, `unknown`. Map to CSS classes: `.printer-card.printing`, `.pc-status.printing`, `.badge-print`, etc.

### Data fetching pattern

Pages use `useEffect` + `api<T>()` for data loading. No server-state library (no TanStack Query/SWR). Typical pattern:

```tsx
const [data, setData] = useState<T[]>([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
  api<T[]>("/api/endpoint").then(setData).finally(() => setLoading(false));
}, []);
```

### Page layout pattern

Authenticated pages render inside `(app)/layout.tsx` which provides sidebar + auth context + toasts. Pages receive `px-6 py-6` padding from the layout. Typical page:

```tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

export default function MyPage() {
  const t = useT();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Item[]>("/api/items").then(setItems).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="skeleton h-64 w-full" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("nav.items")}</h1>
        <button className="btn btn-primary">Add</button>
      </div>
      {/* content */}
    </div>
  );
}
```

### Keyboard shortcuts

- `Cmd+K` / `Ctrl+K` — search modal
- `Cmd+Shift+S` / `Ctrl+Shift+S` — barcode scanner modal

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL | `http://localhost:8000` |

## Build and deploy

- **Dev:** `bun run dev` on `:3000`, backend on `:8000`
- **Build:** `bun run build` — also runs TypeScript type checking
- **Docker:** Multi-stage build with `oven/bun:1-alpine`, outputs standalone Next.js app
- **Production:** `https://monofarm.app`, deployed via Dokploy on Hetzner, auto-deploys on push to `main`

## What NOT to do

- Do not use raw Tailwind color classes (`bg-blue-500`, `text-red-300`) — use design tokens
- Do not use `prefers-color-scheme` — dark mode is class-based
- Do not create components in `src/components/` root — use subfolders
- Do not use `@/components/<Component>` imports — always include the subfolder
- Do not use `useState` for in-flight guards — use `useRef`
- Do not assume Next.js 14/15 APIs work — this is Next.js 16, check docs in `node_modules/next/dist/docs/`
- Do not hardcode API URLs — use the `api()` client from `src/lib/api.ts`
- Do not skip the `organization_id` filter concept — all data is org-scoped on the backend
- Do not use `console.log` in production code
- Do not forget to add translations to both `en.ts` and `uk.ts` when adding new UI text
- Do not use hex color literals or magic numbers — use tokens and constants
- Do not create wrapper abstractions for single-use code
