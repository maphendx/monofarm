# Copy-paste prompt for Claude Code

Drop this into a Claude Code session inside the `monofarm/` repo:

---

You're going to integrate the Monofarm Design System v1.0 across the entire codebase at 100% fidelity. This is a system-wide refit, not a single-page redesign.

**Read these first, in order, before touching code:**

1. `design_handoff_monofarm_design_system/README.md` — the integration plan
2. `design_handoff_monofarm_design_system/Monofarm Design System.html` — open in a browser, click through every section. This is the canonical source of truth for every visual decision.
3. `design_handoff_monofarm_design_system/tokens.css` — drop-in token block for Tailwind v4

**Then execute the 7-phase plan in the README:**

Phase 1. Foundations — replace `globals.css`, wire IBM Plex via `next/font`, default to dark mode, replace logo + favicons
Phase 2. Primitive components — Button, Input, Select, Checkbox, Toggle, Card, Badge, Table, Modal, Toast, Skeleton, Progress
Phase 3. Iconography — `lucide-react` defaults at strokeWidth 1.6
Phase 4. Applied components — PrinterCard (6 states), Sidebar, Topbar, StatStrip, EmptyState with mascot
Phase 5. Pages — dashboard, warehouse, login/register/onboarding, printer detail
Phase 6. Desktop agent (`monofarm/agent/`) — same tokens, native chrome, tray icon with 4 states, live event stream
Phase 7. Motion — adopt motion tokens, respect `prefers-reduced-motion`

**Rules (do not break):**
- No magic numbers — every value comes from a token
- No new colors — flag and ask if you think you need one
- State colors carry meaning (printing/ready/warn/error/offline) — never decorative
- Border-defines-surface in dark mode, not drop shadows
- Density matters: warehouse rows 36–40px, dashboard tight
- Mascot pixel rules: integer scale only, `image-rendering: pixelated`

**Workflow:**
- Build a `/design-system` internal route that imports every primitive — your visual regression target
- After Phase 2, screenshot it and compare side-by-side with the HTML reference
- Refit page-by-page, verifying against the HTML at each step

**Acceptance** (all must pass before saying "done"):
- Every page uses tokens exclusively (zero hex codes in components)
- IBM Plex loaded with Cyrillic subset
- Dark default, light toggle in settings
- All 6 printer states render with correct top-border + dot + copy
- Warehouse table matches section 10.2 of HTML (sticky SKU, mass-edit, color dots)
- Desktop agent matches section 9.0 (native chrome, event stream, tray states)
- `prefers-reduced-motion` honored
- `bun lint` clean, `bun run build` passes
- Lighthouse contrast ≥ AA everywhere

**Single source of truth: when in doubt, open `Monofarm Design System.html` and match it. The HTML wins over my prompt and over your instincts. Don't ship "looks roughly like" — ship "is the design".**

Start by confirming you've read the README and HTML, then list the exact files you plan to touch in Phase 1 before changing anything.

---
