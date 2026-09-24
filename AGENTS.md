# AGENTS.md

Project context for Codex, Gemini CLI, and other AI coding tools. Keep in sync with CLAUDE.md when architecture changes.

> **Private notes:** if `AGENTS.local.md` exists in the repo root (gitignored), read it too — production/deployment details and local-dev specifics live there.

## Project overview

Full-stack 3D print farm management SaaS ("monofarm"). Multi-tenant: each customer gets an isolated `Organization` (printers, files, users, filaments, warehouse). Manages printers via Moonraker/Klipper REST (Snapmaker U1 and other Klipper machines) and Bambu Lab (P1S, A1, A1 mini) via Cloud MQTT + LAN FTPS. Daily print planning, farm task management, filament inventory, warehouse/ERP module (products, stock, orders, production batches, cash flow). Telegram bot for notifications. Billing via Lemon Squeezy (free / starter / pro / farm).

**Stack:** FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL 16 | Next.js 16 App Router + Tailwind v4 + Bun | Redis | S3/R2 | python-telegram-bot 21+

## Repo structure

```text
backend/        FastAPI app (app/api, app/models, app/services, app/core, app/workers)
frontend/       Next.js (src/app, src/components, src/lib)
agent/          Local farm agent (WebSocket tunnel + Bambu camera + U1 alerts)
bruno/          Bruno API collection
docs/           Architecture docs
.claude/rules/  Detailed conventions (shared with Claude Code — read them, see below)
```

## Commands

```bash
# Backend
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
docker compose up -d                       # postgres:16 on :5432
alembic upgrade head
uvicorn app.main:app --reload --port 8000  # dev: INLINE_WORKERS=true in .env

# New migration
alembic revision --autogenerate -m "description"

# Frontend
cd frontend
bun install
bun run dev        # :3000 — restart after globals.css changes (Tailwind v4)
bun run build
bun run lint

# Seed Snapmaker U1 printers (idempotent)
cd backend && python -m scripts.seed_u1        # 12 rows; pass N for custom count

# Tests + lint
cd backend
pip install -r requirements-dev.txt
docker exec printfarm-db psql -U printfarm -d postgres \
  -c "CREATE DATABASE printfarm_test"          # one-time
pytest                 # all tests
pytest tests/unit -q   # unit only (no DB needed)
ruff check .
```

## Testing notes

Tests use a separate `printfarm_test` Postgres DB (override with `TEST_DATABASE_URL`). Schema created from SQLAlchemy models once per session; each test runs in a transaction rolled back on teardown. External services are mocked at fixture level — tests never touch the network. FastAPI lifespan is NOT executed in tests (no scheduler / Bambu MQTT / Telegram). CI: `.github/workflows/ci.yml`.

## Backend architecture (`backend/app/`)

**`main.py`** — FastAPI app. Lifespan seeds admin, starts APScheduler + Bambu MQTT + Telegram bot when `INLINE_WORKERS=true` (dev). Production: `INLINE_WORKERS=false`, those run in a separate worker process (`app/workers/main.py`) to avoid duplicates under `uvicorn --workers N`.

**Routers** (all mounted under `/api`):

| Prefix | Router | Purpose |
| --- | --- | --- |
| `/auth` | auth.py | login, register, me |
| `/users` | users.py | CRUD, Telegram link/unlink |
| `/orgs` | orgs.py | org settings, Bambu cloud credentials, per-org TG bot token |
| `/api-keys` | api_keys.py | long-lived API keys (hashed) |
| `/printers` | printers.py | list (parallel fetch), CRUD, pause/resume/cancel, webcam, speed profile |
| `/printer-groups` | printer_groups.py | grouping + reorder |
| `/tasks/print` | tasks.py | print task kanban (todo/in_progress/done) |
| `/tasks/farm` | farm_tasks.py | farm task kanban |
| `/plan` | plan.py | daily plan (drag-and-drop printer ↔ task) |
| `/filaments` | filaments.py | inventory, adjust stock, FilamentLog |
| `/filament-colors` | filament_colors.py | color palette |
| `/filaments` | filament_labels.py | label generation (PDF via reportlab) |
| `/files` | files.py | gcode/3mf library, upload, send to printer with slot remapping |
| `/folders` | files.py (folders_router) | gcode folder CRUD |
| `/history` | history.py | print history log |
| `/analytics` | analytics.py | summary, daily, printer stats, filament usage |
| `/warehouse` | warehouse.py + warehouse_modules/ | full ERP — see Warehouse module |
| `/keycrm` | keycrm.py | KeyCRM webhook receiver (orders → warehouse orders) |
| `/api/billing` | billing.py | Lemon Squeezy checkout, webhook, cancel |
| `/api/agent` | agent.py + agent_tg.py | farm agent WebSocket tunnel + TG endpoints; version check |
| `/api` | octoprint.py | OctoPrint shim for OrcaSlicer |

**`core/`:** `security.py` — PyJWT + bcrypt (NOT passlib/python-jose — broken on Python 3.14). `config.py` — pydantic-settings; auto-fixes `postgres://` → `postgresql+psycopg://`; requires `ENCRYPTION_KEY` when `ENV=production`. `db.py` — session factory.

**`api/deps.py`** — `HTTPBearer` (not OAuth2PasswordBearer). `get_current_org()` resolves org from JWT and auto-downgrades expired paid plans to `free` on every request.

**`services/`:**
- `bambu.py` — Bambu Cloud HTTP + paho-mqtt per org (TLS :8883) + LAN FTPS upload (:990, user `bblp`, password = access_code). MQTT callbacks write state/AMS to Redis (30s/300s TTL). Token auto-refreshes every 6h.
- `moonraker.py` — sync `requests` via `asyncio.to_thread`. Status cache 10s TTL, meta 300s in Redis. `invalidate_status(url)` clears cache after pause/resume/cancel. `remap_slots(src, slot_map)` — two-pass placeholder rewrite.
- `moonraker_dispatch.py` — unified dispatch of print jobs to Moonraker printers (upload, U1 mapping script, queue).
- `cache.py` — Redis when `REDIS_URL` set, in-process dict fallback.
- `storage.py` — local disk or S3/R2: `put`, `get_bytes`, `delete`, `presigned_url`, `local_path_for` (temp download for S3).
- `gcode_meta.py` — parses slicer comments: types, colors, weights per slot, time, layers. Supports `.3mf`/`.gcode.3mf` (ZIP → `Metadata/plate_N.gcode`). PrusaSlicer, OrcaSlicer, Snaporca, Bambu Studio.
- `encryption.py` — Fernet for sensitive DB fields (Bambu credentials, per-org TG tokens). Required in production.
- `telegram_bot.py` — PTB 21+. Cyrillic commands via `MessageHandler(Regex(...))` (PTB rejects non-ASCII in CommandHandler). Magic-link `/start <code>`. Per-org bot tokens stored encrypted.
- `scheduler.py` — APScheduler: daily 09:00 Kyiv report, Bambu token refresh, print tracker, workflow run processing (5s) + waiting resumes (15s). Cron triggers of workflows sync via `workflow_scheduler.sync_all_jobs()` on start (leader only).
- **Print output chain (`file → print → result → stock`):** operator links products to a file via `PUT /api/files/{id}/outputs` (`GcodeFileOutput`: product, qty_per_run, optional plate; `output_warehouse_id` is the receipt destination). Every dispatch path (`files.send_to_printer`, autoprint, Orca/octoprint shim, workflow `action.send_print`) freezes the links into an immutable `BambuCloudJob.output_plan` via `file_outputs.build_output_plan()` — later config edits never change dispatched/finished runs. One dispatch = one slicer plate: 3MF printing uses `print_plates.file_plates()` + per-plate metadata; Moonraker printers require exported G-code. `print_output.py` is the single accounting path for every reporting surface (bed-clear `POST /printers/{id}/print/clear-bed` with `output`, and late accounting `POST /history/{id}/output`): one run is received exactly once (request_id replay + `uq_wh_movements_run_receipt` partial unique index), runs linked to a live batch update batch counters only (batch close owns receipts), runs of a task marked `output_accounted_from_runs` are never re-accounted at task close, direct prints receipt on confirmation. «Звільнити без обліку» clears the bed leaving the run «Потребує обліку» in history; late accounting never touches printer state. Never auto-create products from file names; filament consumption stays owned by the tracker/costing (no double deduction).
- **Filament consumption accounting (`print_accounting.py` + `filament_accounting.py`):** on every finalized run `print_costing.finalize_print` resolves consumption through the source hierarchy — 1) actual per-slot telemetry, 2) actual total scaled by planned per-slot ratios (Moonraker `print_stats.filament_used` mm→g via slicer diameter/density, guarded against a next-print reset), 3) planned × final progress (Bambu: `BambuCloudJob.progress_pct` from `mc_percent`; completed = 100%), 4) planned for completed runs, 5) equal split with an ambiguity warning. Drivers only report data; every mutation is central: spool deduction + `FilamentLog` (idempotent key `print_history:{id}:slot{n}`), warehouse WRITE_OFF through `_apply_movement` when `Filament.warehouse_product_id` is set (never auto-creates products/warehouses; clamps to book stock and logs the discrepancy), material cost on the history row. Task closing aggregates tracked-run actuals (`FilamentLog.task_id` from the dispatch plan, file/window heuristic as fallback) and never deducts again; planned/manual consumptions are the idempotent fallback for tasks without tracked runs (key `task:{id}:filament{n}`). Partial unique indexes (0094) make run-level `FilamentLog` rows and material WRITE_OFFs idempotent at the DB level.
- **Physical spool inventory & pre-flight (`filament_inventory.py` + `filament_reservations.py`):** `Filament` is a physical spool (human ID `label_id`, warehouse-side `status`: in_stock/empty/retired — "loaded" stays derived from `PrinterSlot`, loading a spool is a location change, never a stock movement). Availability is canonical: `grams_remaining − sum(active FilamentReservation)`; reservations are created transaction-safe at dispatch (`create_cloud_job`, reference `job:{id}:slot{n}`, over-reservation refused), consumed when actual accounting lands (`finalize_print`) and released on terminal job states (`transition_job`). Pre-flight (`preflight_for_print`) checks per slot: required = planned × org margin (`filament_safety_margin_pct`, default 5%); statuses ok/warn/blocked/unmapped + warehouse candidate suggestions (smallest sufficient spool). `files.send_to_printer` runs it (blocking only when `preflight_block_dispatch` is enabled by the admin) and `GET /api/files/{id}/preflight` feeds the SendModal strip. Receiving: `POST /api/materials/receive` — one PURCHASE_IN for the delivery + per-spool records with `FilamentLog` (the receipt happens once; spools are containers). `GET /api/materials/reconciliation` exposes ledger-vs-spools discrepancies per linked product — diagnostics only, never auto-fixed.
- **Spool warehouse workflow (0096):** receiving captures `Filament.warehouse_id` + `receipt_id` and optional price; g/kg conversions are explicit. `request_payload_json.material_plan` freezes mapped physical slots, spool IDs, planned grams and costs at dispatch; live tracker entries capture `PrintHistory.material_plan`. Preflight/reservations use the same physical mapping. `POST /materials/{id}/remaining` applies one optimistic, replay-safe absolute correction to spool + warehouse; ordinary weight edits also route through the accounting service. Warehouse product stock tabs show physical spools and links to print consumption. See `docs/MATERIAL_ACCOUNTING.md` for legacy limits and tests.
- **Ready-made notifications (no workflow engine needed):** org toggles `notify_print_failed` / `notify_filament_low` in Settings → Сповіщення. `telegram_notify.py` queues alerts in `telegram_notifications` in the source transaction (migration 0093); the existing scheduler runs `process_pending_notifications()` every 5s. Print failures use the persisted history ID across MQTT/tracker producers. Filament crossings use `low_alert_active` / `low_alert_episode` persisted with the spool change; refill re-arms even while notifications are disabled. The worker commits a claim before Telegram I/O; failed/ambiguous attempts are retained and never automatically retried (no duplicates across worker restarts, but delivery is not guaranteed). Ready-made rules and reachable Telegram workflow actions for the same event are mutually exclusive when enabling/editing; settings show the names of the active owners, including when the editor is hidden. Migration 0093 preserves existing workflow ownership by disabling overlapping built-in rules. See `docs/DAILY_OPERATIONS.md` for UX, delivery limits and acceptance checks.
- `print_tracker.py` — tracks active jobs, writes `PrintHistory` on completion.
- **Workflow engine (EXPERIMENTAL):** `workflow_events.py` (event bus: `publish_event(db, org_id, type, payload)` — never raises, creates pending runs in the caller's transaction), `workflow_engine.py` (resumable graph executor: nodes/edges JSONB, expression `{{path}}` resolver, per-node handlers, `flow.wait` suspends runs), `workflow_nodes.py` (node catalog + graph validation — single source of truth shared with the frontend editor), `workflow_scheduler.py` (cron trigger sync into APScheduler). Models: `Workflow`, `WorkflowRun` (graph snapshot per run; org-scoped). Runs execute in the scheduler-enabled process (worker leader). API: `/api/workflows` (CRUD, runs, catalog) + public webhook trigger `/api/workflows/hooks/whk-<id>-<secret>`. Events published today: print.completed/failed/cancelled, printer.state_changed, order.created/shipped, filament.low. Frontend: `/workflows` and `/workflows/[id]` share `FlowWorkspace` (React Flow canvas with on-demand step/configuration/execution panels styled like the production FlowView). Automation workflows stay separate from the dashboard; dashboard `FlowView` remains the production overview. Components live in `components/workflows/`.
  - **Gating (`Organization.workflows_enabled`, default off):** an admin enables the editor in Settings → Сповіщення → Експериментальні функції. With the flag off, list/view/catalog/runs and disable-only (`PUT` with just `enabled: false`) remain available; create/edit/delete/run-now return 403. Sidebar remains discoverable for orgs with existing workflows. The canvas is read-only and exposes a separate disable action and admin settings link. Active runs, events, cron and public webhooks do not depend on editor visibility. Workflow event publication uses a savepoint so an execution-record SQL failure does not poison the source accounting transaction.

- `tunnel.py` — WebSocket manager for farm agents (JWT auth, proxy HTTP to local Moonraker).
- `go2rtc.py` — camera stream proxy via go2rtc sidecar (`GO2RTC_URL`).
- `bootstrap.py` — seeds admin user + default org on first start.

## Warehouse module (`api/warehouse.py`, `api/warehouse_modules/`, `models/warehouse.py`)

Categories → Products (SKU, barcode, cost/sale price, thresholds; CSV import/export) → Specifications (BOM: components + operations) → Stock per warehouse → Movements ledger (PURCHASE_IN / SALE_OUT / RETURN_IN / TRANSFER / ADJUSTMENT / PRODUCTION_IN / PRODUCTION_OUT / WRITE_OFF) → Production Batches (open/close writes production movements) → Orders (reserve → ship → SALE_OUT; source: manual/keycrm) → Counterparties (balance tracking) → Cash Flow → Analytics. Warehouses (physical/virtual/consignment) have Zones → Cells → CellStock; invariant sum(cells) ≤ StockEntry.qty.

`api/warehouse.py` only composes domain routers. Endpoint implementations live in `api/warehouse_modules/` by domain; cross-domain stock, AVCO, bin and serialization invariants live in `common.py`. Large collection endpoints use bounded `skip`/`limit` pagination (100 by default, 500 maximum), while frontend views that need a complete collection traverse all pages with `apiAll()`.

**KeyCRM:** webhook at `POST /api/keycrm/webhook/{org_slug}`, HMAC-SHA256 validated via org's `keycrm_webhook_secret`. Creates/updates `Order` + `OrderItem`.

## Data model

**Print farm:** `Printer` (kind: snapmaker_u1|bambu|other; `loaded_filaments` JSONB, 0-based slots; manual_status for non-API printers), `PrintTask` (kanban card; `filament_meta` JSONB), `FarmTask`, `PlanEntry` (Printer × PrintTask × date; cascade-deleted with printer), `PrintHistory`, `PrinterGroup`, `Filament` (`grams_remaining`, `min_grams`, `is_low`, `cost_per_kg`), `FilamentLog`, `FilamentColor`, `GcodeFile` (`stored_name` UUID; local `data/gcodes/` or S3 `orgs/{org_id}/gcodes/`), `GcodeFolder`, `ApiKey`.

**Org:** `Organization` (plan: free|starter|pro|farm, `plan_expires_at`, encrypted Bambu/TG credentials, `keycrm_webhook_secret`, `extra_printer_slots`), `User` (role: admin|operator|manager, `telegram_chat_id`).

**Warehouse:** `ProductCategory`, `Product`, `Specification` + `SpecComponent` + `SpecOperation`, `Warehouse`, `WarehouseZone`, `WarehouseCell`, `CellStock`, `StockEntry`, `WarehouseMovement`, `ProductionBatch`, `Order` + `OrderItem`, `Counterparty`, `CashTransaction`.

## Frontend (`frontend/src/`)

**Pages** (`app/(app)/`): `/dashboard` (live printer grid), `/printers/[id]`, `/tasks`, `/plan`, `/files` (SendModal with slot badges), `/filament`, `/history`, `/analytics`, `/users`, `/settings`, `/support`, `/warehouse` + sub-pages: `products`, `products/[id]`, `stock`, `movements`, `orders`, `production`, `assembly`, `scanner`, `categories`, `counterparties`, `cashflow`, `warehouses`, `warehouses/[id]`, `specs`, `analytics`.

**Components** (`src/components/`): subfolders only — `ui/ layout/ printers/ dashboard/ filament/ files/ users/ labels/ plan/ queue/ warehouse/`. Never add components to the components root. Check existing components and `globals.css` utility classes before writing new UI.

**Key lib files:**
- `lib/api.ts` — `api<T>(path, init?)` injects JWT from localStorage, throws `ApiError` on non-2xx. Skips `Content-Type: application/json` for `FormData`.
- `lib/auth-context.tsx` — `useUser()` hook.
- `lib/i18n.tsx` — Ukrainian/English translations. All UI strings go through it.
- `app/globals.css` — `@custom-variant dark` for class-based dark mode. **Restart dev server after any change.**
- `app/layout.tsx` — inline `<script>` applies `.dark` before hydration.

## Critical conventions

- **Slot indexing:** 0-based everywhere (DB, gcode `T0..T3`, API `slot_map`). UI shows 1-based — convert at render time only.
- **Slot remapping:** two-pass (`T<n>` → `__TOOL_<n>__` → target) to avoid A→B→A collisions. Skipped for identity maps. Bambu: no rewrite — `slot_map` → `ams_mapping` in MQTT.
- **Worker separation:** `INLINE_WORKERS=false` in production; `app/workers/main.py` runs Telegram + APScheduler + Bambu MQTT.
- **Moonraker URLs:** always pass raw user-entered URLs through `_api_base(url)` (strips path + `?printer=<hash>`).
- **Moonraker cache:** call `moonraker.invalidate_status(url)` after pause/resume/cancel.
- **Printer states:** unified vocabulary — `idle`, `printing`, `paused`, `operational`, `error`, `offline`, `unknown`. Moonraker map in `moonraker.py` `_STATE_MAP`; Bambu map in `bambu.py` `_GCODE_STATE_MAP`.
- **Filament metadata fallback** (`api/printers.py:_resolve_filament_for_file`): 1) local `PrintTask` with matching `file_name` + `filament_meta`; 2) Moonraker `/server/files/metadata`; 3) range-download last 96KB + `gcode_meta.parse_gcode()`.
- **Bambu printers:** auto-imported via `_ensure_bambu_rows()`. Upload via LAN FTPS; print via MQTT `project_file` with `ams_mapping`.
- **3MF extension:** `.gcode.3mf` is double-extension — use `"".join(p.suffixes)`, not `p.suffix`.
- **OctoPrint shim:** OrcaSlicer → Host Type OctoPrint, Hostname = backend URL, API Key = JWT. Upload → parse meta → frontend auto-opens SendModal.
- **Double-submit guard:** `useRef` inFlight guard (not `useState`) for plan actions.
- **Encryption:** Fernet (`ENCRYPTION_KEY`) for Bambu credentials + per-org TG tokens. Required in production, skipped in dev.
- **Python 3.14:** never use `passlib`, `python-jose`, `psycopg-binary` — broken. Use `bcrypt`, `PyJWT`, `psycopg[binary]>=3.3.0`.
- **Migrations:** sequential naming `0001_`, `0002_`, … — never leave auto-generated UUID names, never edit applied migrations.
- **No magic strings** — use constants/enums. Small single-responsibility functions. No speculative abstractions.

## Required `.env` (backend)

```bash
DATABASE_URL=postgresql+psycopg://printfarm:printfarm@localhost:5432/printfarm
SECRET_KEY=<random 32+ chars>
ENV=development                 # "production" enforces ENCRYPTION_KEY
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<password>
ENCRYPTION_KEY=<fernet key>
INLINE_WORKERS=true             # false in multi-worker production
BAMBU_EMAIL=<email>
BAMBU_REFRESH_TOKEN=<token>     # preferred for 2FA accounts
BAMBU_REGION=us                 # us | eu | cn
FARM_PUBLIC_URL=https://your-domain
CORS_ORIGINS=http://localhost:3000
TIMEZONE=Europe/Kiev
REDIS_URL=rediss://...          # empty = in-process dict fallback
S3_ENDPOINT_URL=https://...     # empty = local disk at data/gcodes/
S3_ACCESS_KEY=<key>
S3_SECRET_KEY=<secret>
S3_BUCKET=monofarm-files
LMSQ_API_KEY=<key>
LMSQ_WEBHOOK_SECRET=<secret>
LMSQ_STORE_ID=<id>
LMSQ_VARIANT_STARTER=<variant_id>
LMSQ_VARIANT_PRO=<variant_id>
LMSQ_VARIANT_FARM=<variant_id>
GO2RTC_URL=http://localhost:1984  # empty = disabled
```

## Detailed rules (shared with Claude Code)

Before working in an area, read the matching file in `.claude/rules/`:

- `backend-python.md` — Python/FastAPI conventions (slots, Moonraker, Python 3.14)
- `frontend-next.md` — Next.js conventions (Tailwind v4, API client, design tokens)
- `components.md` — component subfolder structure + import paths
- `api-conventions.md` — URL prefix, auth deps, org isolation, response patterns
- `warehouse.md` — stock ledger, AVCO, order/batch state machines
- `agent.md` — local farm agent: version bumps, wire protocol, auth
- `migrations.md` — Alembic: sequential naming, never edit applied migrations

For gesture-driven UI, spring animation, drag/swipe/sheet interactions, translucent materials, or typography work, also read `.claude/skills/apple-design/SKILL.md` — Apple HIG-style interaction design guidance (adopted from [emilkowalski/skills](https://github.com/emilkowalski/skills)). Claude Code auto-loads this as a project skill; read it directly before touching animation, gesture, or visual-design code.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- Run graphify commands via the project venv: `. .venv-graphify/bin/activate` (or call `.venv-graphify/bin/graphify` directly).

## Tenant security invariants

- Access JWTs require `typ=access` and `ver`; authenticate against the current user organization, role, active flag and `session_version` through `authenticate_user`. Password/account security changes revoke credentials. Migration `0086` adds the version.
- Moonraker and Bambu caches, Bambu MQTT routing/acknowledgments, and go2rtc stream names must include organization identity. Pass the required `org_id`; never fall back to URL-only or serial-only keys.
- File thumbnails require organization authentication. Use `AuthImage` for API thumbnail URLs; do not restore public ID-only thumbnail access.
- Agent connections/configuration require a tenant-admin session. Use the authenticated tunnel organization, never an organization supplied in an agent payload.
- See `docs/SECURITY_REVIEW_2026-09-10.md` for verification, deployment requirements and remaining confidentiality boundaries.

## Agent tunnel routing

- `services/tunnel_router.py` routes agent commands/responses over Redis Pub/Sub between web and background-worker processes. The socket owner has a 15-second Redis lease and a unique connection ID; requests remain pinned to that connection.
- All web and worker instances must share a private `REDIS_URL`. Without Redis, tunnels support only one web process. Redis routing failures fail closed; do not silently use process-local presence when Redis is configured.
- Keep the agent wire protocol unchanged when changing internal routing. Route all request senders through `tunnel.py`; propagate the authenticated organization and preserve upload progress, camera cleanup and connection fencing.
- Never automatically retry an ambiguously delivered printer command. Redis delivery permits and acknowledgments are transport guards, not proof of physical execution.
- See `docs/AGENT_TUNNEL_ROUTING.md` for lifecycle, tests, limits and deployment requirements.

## Edge agent module boundaries

- `agent/monofarm_agent.py` is a compatibility facade and CLI. Keep implementation in `agent/core/`, `agent/transports/`, or `agent/printers/`.
- `core/runtime.py` owns the canonical connection/reconnect lifecycle. `transports/websocket.py` owns wire parsing and dispatch. Printer-specific protocols stay in their corresponding module.
- Linux/source distribution is a complete archive defined by `agent/source_manifest.json`; keep it current whenever a runtime file is added or removed. Pre-0.8.16 flat installs rely on the facade bootstrap.
- Windows continues to enter through `monofarm_tray.py`; keep the PyInstaller hidden imports synchronized with package changes.
- See `docs/EDGE_AGENT_ARCHITECTURE.md` for the module map and compatibility contract.
