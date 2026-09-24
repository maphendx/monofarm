# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Claude Code harness:** team config lives in [`.claude/`](.claude/CLAUDE.md) (`rules/`, `commands/`, `agents/`, shared `settings.json`). Slash workflows: `/backend-test`, `/frontend-check`, `/graphify-refresh`. Optional private notes in `CLAUDE.local.md` (gitignored).

## Project overview

Full-stack 3D print farm management SaaS ("monofarm"). Multi-tenant: each customer gets an isolated `Organization` (printers, files, users, filaments, warehouse). Manages printers via Moonraker/Klipper REST (Snapmaker U1 and other Klipper machines) and Bambu Lab (P1S, A1, A1 mini) via Cloud MQTT + LAN FTPS. Daily print planning, farm task management, filament inventory, warehouse/ERP module (products, stock, orders, production batches, cash flow). Telegram bot for notifications. Billing via Lemon Squeezy (free / starter / pro / farm).

## Commands

```bash
# Backend
cd backend
python -m venv .venv && . .venv/bin/activate   # macOS
pip install -r requirements.txt

# DB (requires Docker)
docker compose up -d                            # starts postgres:16 on :5432

# Migrations
alembic upgrade head
# New migration:
alembic revision --autogenerate -m "description"

# Run API (dev — single process, INLINE_WORKERS=true in .env)
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
bun install
bun run dev        # :3000 — must restart after globals.css changes (Tailwind v4)
bun run build
bun run lint

# Seed Snapmaker U1 printers (idempotent)
cd backend
python -m scripts.seed_u1        # creates 12 U1 rows
python -m scripts.seed_u1 6      # creates N rows

# Tests + lint
cd backend
pip install -r requirements-dev.txt
docker exec printfarm-db psql -U printfarm -d postgres \
  -c "CREATE DATABASE printfarm_test"            # one-time
pytest                                            # all tests (unit + integration)
pytest tests/unit -q                              # unit only (no DB needed)
ruff check .
```

Tests use a separate `printfarm_test` Postgres database. Override with `TEST_DATABASE_URL=...`. Schema is created from SQLAlchemy models (`Base.metadata.create_all`) once per session; each test runs inside a transaction that's rolled back on teardown. External services are mocked at the fixture level — tests never touch the network. The FastAPI lifespan is NOT executed in tests, so scheduler / Bambu MQTT / Telegram never start. CI: `.github/workflows/ci.yml`.

## Architecture

### Backend (`backend/app/`)

**`main.py`** — FastAPI app. Lifespan: seeds admin, starts APScheduler + Bambu MQTT + Telegram bot when `INLINE_WORKERS=true` (dev). In production `INLINE_WORKERS=false` — these run in a separate worker process (`app/workers/main.py`) to avoid duplicate bots/schedulers under `uvicorn --workers N`.

**Routers** (all mounted under `/api`):

| Router | Prefix | Notes |
| --- | --- | --- |
| `auth.py` | `/auth` | login, register, me |
| `users.py` | `/users` | CRUD, Telegram link/unlink |
| `orgs.py` | `/orgs` | org settings, Bambu cloud credentials, per-org TG bot token |
| `api_keys.py` | `/api-keys` | long-lived API keys |
| `printers.py` | `/printers` | list (parallel fetch), CRUD, pause/resume/cancel, webcam, speed profile |
| `printer_groups.py` | `/printer-groups` | grouping + reorder |
| `tasks.py` | `/tasks/print` | print task kanban (todo/in_progress/done) |
| `farm_tasks.py` | `/tasks/farm` | farm task kanban |
| `plan.py` | `/plan` | daily plan (drag-and-drop printer ↔ task) |
| `filaments.py` | `/filaments` | inventory, adjust stock, FilamentLog |
| `filament_colors.py` | `/filament-colors` | color palette |
| `filament_labels.py` | `/filaments` | label generation (PDF via reportlab) |
| `files.py` | `/files` | gcode/3mf library, upload, send to printer with slot remapping |
| `folders_router` | `/folders` | gcode folder CRUD |
| `history.py` | `/history` | print history log |
| `analytics.py` | `/analytics` | summary, daily, printer stats, filament usage |
| `warehouse.py` + `warehouse_modules/` | `/warehouse` | full ERP — see Warehouse module section |
| `keycrm.py` | `/keycrm` | KeyCRM webhook receiver (orders → warehouse orders) |
| `billing.py` | `/api/billing` | Lemon Squeezy checkout, webhook, cancel |
| `agent.py` | `/api/agent` | WebSocket tunnel for local farm agent; version check |
| `agent_tg.py` | `/api/agent` | agent Telegram endpoints (tg-config, tg-command) |
| `octoprint.py` | `/api` | OctoPrint shim for OrcaSlicer |

**`core/`:**
- `security.py` — PyJWT + bcrypt (not passlib/python-jose — broken on Python 3.14)
- `config.py` — pydantic-settings; auto-fixes `postgres://` → `postgresql+psycopg://`; requires `ENCRYPTION_KEY` when `ENV=production`
- `db.py` — SQLAlchemy session factory

**`api/deps.py`** — `HTTPBearer` (not OAuth2PasswordBearer). `get_current_org()` resolves org from JWT and **auto-downgrades expired paid plans to `free`** on every request.

**`services/`:**
- `bambu.py` — Bambu Cloud HTTP + paho-mqtt per org (TLS :8883) + LAN FTPS upload. MQTT callbacks write state/AMS to Redis (30s/300s TTL). `get_cached_state()` / `get_ams_filaments()` read Redis first. Token auto-refreshes every 6h.
- `moonraker.py` — sync `requests` via `asyncio.to_thread`. Status cache 10s TTL, meta cache 300s in Redis. `invalidate_status(url)` clears Redis + local dict. `remap_slots(src, slot_map)` — two-pass placeholder rewrite for collision-safe slot swaps.
- `cache.py` — Redis when `REDIS_URL` set, in-process dict fallback. Thread-safe `cache_get/cache_set/cache_delete`.
- `storage.py` — local disk or S3/R2. `put`, `get_bytes`, `delete`, `presigned_url`, `local_path_for` (context manager — downloads to temp for S3).
- `gcode_meta.py` — parses slicer comments: types, colors, weights per slot, time, layers. Supports `.3mf`/`.gcode.3mf` (ZIP → `Metadata/plate_N.gcode`). Works for PrusaSlicer, OrcaSlicer, Snaporca, Bambu Studio.
- `encryption.py` — Fernet symmetric encryption for sensitive DB fields (Bambu credentials per org). Required in production.
- `telegram_bot.py` — PTB 21+. Cyrillic commands via `MessageHandler(Regex(...))` (not `CommandHandler` — PTB rejects non-ASCII). Magic-link `/start <code>` for account linking. Also supports per-org bot tokens (stored encrypted in DB).
- `daily_report.py` — `build_status_text()` / `build_daily_report()` for 09:00 Kyiv broadcast.
- `scheduler.py` — APScheduler wrapper: daily report job, Bambu token refresh, print tracker, workflow run processing (5s) + waiting resumes (15s). Cron triggers of workflows sync via `workflow_scheduler.sync_all_jobs()` on start (leader only).
- **Print output chain (`file → print → result → stock`):** operator links products to a file via `PUT /api/files/{id}/outputs` (`GcodeFileOutput`: product, qty_per_run, optional plate; `output_warehouse_id` is the receipt destination). Every dispatch path (`files.send_to_printer`, autoprint, Orca/octoprint shim, workflow `action.send_print`) freezes the links into an immutable `BambuCloudJob.output_plan` via `file_outputs.build_output_plan()` — later config edits never change dispatched/finished runs. One dispatch = one slicer plate: 3MF printing uses `print_plates.file_plates()` + per-plate metadata; Moonraker printers require exported G-code. `print_output.py` is the single accounting path for every reporting surface (bed-clear `POST /printers/{id}/print/clear-bed` with `output`, and late accounting `POST /history/{id}/output`): one run is received exactly once (request_id replay + `uq_wh_movements_run_receipt` partial unique index), runs linked to a live batch update batch counters only (batch close owns receipts), runs of a task marked `output_accounted_from_runs` are never re-accounted at task close, direct prints receipt on confirmation. «Звільнити без обліку» clears the bed leaving the run «Потребує обліку» in history; late accounting never touches printer state. Never auto-create products from file names; filament consumption stays owned by the tracker/costing (no double deduction).
- **Filament consumption accounting (`print_accounting.py` + `filament_accounting.py`):** on every finalized run `print_costing.finalize_print` resolves consumption through the source hierarchy — 1) actual per-slot telemetry, 2) actual total scaled by planned per-slot ratios (Moonraker `print_stats.filament_used` mm→g via slicer diameter/density, guarded against a next-print reset), 3) planned × final progress (Bambu: `BambuCloudJob.progress_pct` from `mc_percent`; completed = 100%), 4) planned for completed runs, 5) equal split with an ambiguity warning. Drivers only report data; every mutation is central: spool deduction + `FilamentLog` (idempotent key `print_history:{id}:slot{n}`), warehouse WRITE_OFF through `_apply_movement` when `Filament.warehouse_product_id` is set (never auto-creates products/warehouses; clamps to book stock and logs the discrepancy), material cost on the history row. Task closing aggregates tracked-run actuals (`FilamentLog.task_id` from the dispatch plan, file/window heuristic as fallback) and never deducts again; planned/manual consumptions are the idempotent fallback for tasks without tracked runs (key `task:{id}:filament{n}`). Partial unique indexes (0094) make run-level `FilamentLog` rows and material WRITE_OFFs idempotent at the DB level.
- **Physical spool inventory & pre-flight (`filament_inventory.py` + `filament_reservations.py`):** `Filament` is a physical spool (human ID `label_id`, warehouse-side `status`: in_stock/empty/retired — "loaded" stays derived from `PrinterSlot`, loading a spool is a location change, never a stock movement). Availability is canonical: `grams_remaining − sum(active FilamentReservation)`; reservations are created transaction-safe at dispatch (`create_cloud_job`, reference `job:{id}:slot{n}`, over-reservation refused), consumed when actual accounting lands (`finalize_print`) and released on terminal job states (`transition_job`). Pre-flight (`preflight_for_print`) checks per slot: required = planned × org margin (`filament_safety_margin_pct`, default 5%); statuses ok/warn/blocked/unmapped + warehouse candidate suggestions (smallest sufficient spool). `files.send_to_printer` runs it (blocking only when `preflight_block_dispatch` is enabled by the admin) and `GET /api/files/{id}/preflight` feeds the SendModal strip. Receiving: `POST /api/materials/receive` — one PURCHASE_IN for the delivery + per-spool records with `FilamentLog` (the receipt happens once; spools are containers). `GET /api/materials/reconciliation` exposes ledger-vs-spools discrepancies per linked product — diagnostics only, never auto-fixed.
- **Spool warehouse workflow (0096):** receiving captures `Filament.warehouse_id` + `receipt_id` and optional price; g/kg conversions are explicit. `request_payload_json.material_plan` freezes mapped physical slots, spool IDs, planned grams and costs at dispatch; live tracker entries capture `PrintHistory.material_plan`. Preflight/reservations use the same physical mapping. `POST /materials/{id}/remaining` applies one optimistic, replay-safe absolute correction to spool + warehouse; ordinary weight edits also route through the accounting service. Warehouse product stock tabs show physical spools and links to print consumption. See `docs/MATERIAL_ACCOUNTING.md` for legacy limits and tests.
- **Ready-made notifications (no workflow engine needed):** org toggles `notify_print_failed` / `notify_filament_low` in Settings → Сповіщення. `telegram_notify.py` queues alerts in `telegram_notifications` in the source transaction (migration 0093); the existing scheduler runs `process_pending_notifications()` every 5s. Print failures use the persisted history ID across MQTT/tracker producers. Filament crossings use `low_alert_active` / `low_alert_episode` persisted with the spool change; refill re-arms even while notifications are disabled. The worker commits a claim before Telegram I/O; failed/ambiguous attempts are retained and never automatically retried (no duplicates across worker restarts, but delivery is not guaranteed). Ready-made rules and reachable Telegram workflow actions for the same event are mutually exclusive when enabling/editing; settings show the names of the active owners, including when the editor is hidden. Migration 0093 preserves existing workflow ownership by disabling overlapping built-in rules. See `docs/DAILY_OPERATIONS.md` for UX, delivery limits and acceptance checks.
- `print_tracker.py` — tracks active print jobs, writes to `PrintHistory` on completion.
- **Workflow engine (EXPERIMENTAL):** `workflow_events.py` (event bus: `publish_event(db, org_id, type, payload)` — never raises, creates pending runs in the caller's transaction), `workflow_engine.py` (resumable graph executor: nodes/edges JSONB, expression `{{path}}` resolver, per-node handlers, `flow.wait` suspends runs), `workflow_nodes.py` (node catalog + graph validation — single source of truth shared with the frontend editor), `workflow_scheduler.py` (cron trigger sync into APScheduler). Models: `Workflow`, `WorkflowRun` (graph snapshot per run; org-scoped). Runs execute in the scheduler-enabled process (worker leader). API: `/api/workflows` (CRUD, runs, catalog) + public webhook trigger `/api/workflows/hooks/whk-<id>-<secret>`. Events published today: print.completed/failed/cancelled, printer.state_changed, order.created/shipped, filament.low. Frontend: `/workflows` and `/workflows/[id]` share `FlowWorkspace` (React Flow canvas with on-demand step/configuration/execution panels styled like the production FlowView). Automation workflows stay separate from the dashboard; dashboard `FlowView` remains the production overview. Components live in `components/workflows/`.
  - **Gating (`Organization.workflows_enabled`, default off):** an admin enables the editor in Settings → Сповіщення → Експериментальні функції. With the flag off, list/view/catalog/runs and disable-only (`PUT` with just `enabled: false`) remain available; create/edit/delete/run-now return 403. Sidebar remains discoverable for orgs with existing workflows. The canvas is read-only and exposes a separate disable action and admin settings link. Active runs, events, cron and public webhooks do not depend on editor visibility. Workflow event publication uses a savepoint so an execution-record SQL failure does not poison the source accounting transaction.

### Warehouse module (`api/warehouse.py`, `api/warehouse_modules/`, `models/warehouse.py`)

Full ERP layer. All under `/api/warehouse`:

`api/warehouse.py` is the compatibility facade and composes domain routers from
`api/warehouse_modules/`. Shared stock, AVCO, bin and serialization invariants
live in `common.py`. Large collections use bounded `skip`/`limit` pagination
(100 by default, 500 maximum); frontend views that require the full collection
walk those pages through `apiAll()`.

| Group | Endpoints |
| --- | --- |
| Categories | CRUD for product categories (name, color, sort_order) |
| Products | CRUD, barcode, cost/sale price, stock thresholds; CSV import/export; Ordage spec import |
| Specifications | Bill of materials per product: components + operations (cut/sew/print/pack/other); cost breakdown |
| Stock | Per-warehouse stock entries; movements (PURCHASE_IN, SALE_OUT, RETURN_IN, TRANSFER, ADJUSTMENT, PRODUCTION_IN, PRODUCTION_OUT, WRITE_OFF) |
| Warehouses | CRUD, type (physical/virtual/consignment), zones + cells |
| Zones & Cells | Warehouse zones → cells → CellStock (per-product per-cell quantity) |
| Production Batches | Create batch (links product + spec), close batch (writes production movements) |
| Orders | CRUD, reserve stock, ship (writes SALE_OUT movements), cancel; source: manual/keycrm |
| Counterparties | Suppliers/customers with balance tracking |
| Cash Flow | Income/expense transactions with category; summary endpoint |
| Analytics | Revenue, COGS, top products, stock value |

**KeyCRM integration** (`api/keycrm.py`): webhook receiver at `POST /api/keycrm/webhook/{org_slug}`. Validates HMAC-SHA256 signature. Creates/updates `Order` + `OrderItem` rows from KeyCRM order payload. Org must have `keycrm_webhook_secret` set.

### Frontend (`frontend/src/`)

Next.js 16 App Router, Tailwind v4, Bun.

**Pages** (`app/(app)/`):

| Route | Description |
| --- | --- |
| `/dashboard` | Live printer grid, PrinterCard with status/progress/camera |
| `/printers/[id]` | Printer detail: temps, progress, ETA, webcam, controls |
| `/tasks` | Print task kanban (todo / in_progress / done) |
| `/plan` | Daily print plan — drag tasks onto printers |
| `/files` | Gcode/3mf library; SendModal with slot compatibility badges |
| `/filament` | Filament inventory, low-stock warnings, label printing |
| `/history` | Print history log |
| `/analytics` | Charts: daily output, printer utilization, filament usage |
| `/users` | User management, Telegram linking |
| `/settings` | Org settings, printer management, API keys, billing |
| `/warehouse` | Warehouse dashboard |
| `/warehouse/products` | Product catalog |
| `/warehouse/products/[id]` | Product detail + specs |
| `/warehouse/stock` | Stock levels per warehouse |
| `/warehouse/movements` | Stock movement log |
| `/warehouse/orders` | Order management |
| `/warehouse/production` | Production batches |
| `/warehouse/assembly` | Assembly view |
| `/warehouse/categories` | Product categories |
| `/warehouse/counterparties` | Counterparty management |
| `/warehouse/cashflow` | Cash flow transactions |
| `/warehouse/warehouses` | Warehouse CRUD |
| `/warehouse/warehouses/[id]` | Warehouse zones/cells/stock |
| `/warehouse/specs` | Specification library |
| `/warehouse/analytics` | Warehouse analytics |

**Components** (`src/components/`) — organized into subfolders:

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

**Key lib files:**
- `lib/api.ts` — `api<T>(path, init?)` injects JWT from localStorage, throws `ApiError` on non-2xx. Skips `Content-Type: application/json` for `FormData`.
- `lib/auth-context.tsx` — `useUser()` hook.
- `lib/i18n.tsx` — Ukrainian/English translations.
- `app/globals.css` — `@custom-variant dark` for class-based dark mode. **Requires dev server restart after any change.**
- `app/layout.tsx` — inline `<script>` applies `.dark` before hydration.

### Data model

**Print farm:**
- `Printer` — `kind: PrinterKind` (snapmaker_u1 | bambu | other), `moonraker_url`, `bambu_dev_id/bambu_access_code/bambu_dev_ip/bambu_model`. `loaded_filaments: JSONB` (0-based slots). `manual_status/job/eta_minutes` for non-API printers.
- `PrintTask` — kanban card. `filament_meta: JSONB` (types, colors, used_g, estimated_minutes, layers, layer_height).
- `FarmTask` — operational task (kanban).
- `PlanEntry` — Printer × PrintTask × date join. Cascade-deleted with printer.
- `PrintHistory` — completed print log.
- `PrinterGroup` — grouping with sort_order.
- `Filament` — inventory. `grams_remaining`, `min_grams`, `is_low` computed property. `cost_per_kg`.
- `FilamentLog` — stock adjustment history.
- `FilamentColor` — color palette per org.
- `GcodeFile` — `stored_name` (UUID), `original_name`, `filament_meta: JSONB`. Local: `data/gcodes/<stored_name>`. S3: `orgs/{org_id}/gcodes/<stored_name>`.
- `GcodeFolder` — folder hierarchy for file library.
- `ApiKey` — long-lived tokens (hashed).
- `PrintHistory` — print job log with duration, grams used.

**Organization & users:**
- `Organization` — `plan: OrgPlan` (free|starter|pro|farm), `plan_expires_at`, `bambu_email/refresh_token/region` (encrypted), `tg_bot_token` (encrypted per-org), `keycrm_webhook_secret`, `extra_printer_slots`.
- `User` — `role: UserRole` (admin|operator|manager), `telegram_chat_id`.

**Warehouse (all in `models/warehouse.py`):**
- `ProductCategory`, `Product` (SKU, barcode, prices, stock thresholds), `Specification` + `SpecComponent` + `SpecOperation`
- `Warehouse` (type: physical|virtual|consignment), `WarehouseZone`, `WarehouseCell`, `CellStock`
- `StockEntry` (current stock per product per warehouse), `WarehouseMovement` (ledger)
- `ProductionBatch` (status: open|closed), `Order` + `OrderItem` (source: manual|keycrm)
- `Counterparty` (type: supplier|customer, balance), `CashTransaction` (type: income|expense)

## Critical conventions

**Worker separation:** `INLINE_WORKERS=false` in production. Set `INLINE_WORKERS=true` in `.env` for local dev (single process). The separate worker process (`app/workers/main.py`) runs Telegram, APScheduler, and Bambu MQTT — prevents duplicates under `uvicorn --workers N`.

**Moonraker URL handling:** `_api_base(url)` strips path and `?printer=<hash>` query params. Always pass raw user-entered URLs through `_api_base()`.

**Printer state vocabulary:** Moonraker `print_stats.state` → `_STATE_MAP` in `moonraker.py`. Bambu `gcode_state` (IDLE/RUNNING/PAUSE/FINISH/FAILED) → `_GCODE_STATE_MAP` in `bambu.py`. Unified: `idle`, `printing`, `paused`, `operational`, `error`, `offline`, `unknown`.

**Filament metadata fallback chain** (`api/printers.py:_resolve_filament_for_file`):
1. Local DB: `PrintTask` with matching `file_name` and non-null `filament_meta`.
2. Moonraker `/server/files/metadata`.
3. Range-download last 96KB + local `gcode_meta.parse_gcode()`.

**Bambu Lab printers:** auto-imported via `_ensure_bambu_rows()`. MQTT `device/{dev_id}/report` → Redis (30s TTL for state, 300s for AMS). File upload: LAN FTPS (:990, user `bblp`, password = access_code). Print: MQTT `project_file` with `ams_mapping`.

**Moonraker cache invalidation:** `moonraker.invalidate_status(url)` after pause/resume/cancel — clears Redis key + local stale dict.

**Slot indexing:** 0-based everywhere (DB, gcode `T0..T3`, API `slot_map`). UI shows 1-based — convert at render time only.

**Slot remapping:** Two-pass (`T<n>` → `__TOOL_<n>__` → target) to avoid A→B→A collision. Skipped for identity maps. Bambu: no rewrite — `slot_map` → `ams_mapping` in MQTT.

**3MF extension:** `.gcode.3mf` is double-extension. Use `"".join(p.suffixes)` not `p.suffix`. `parse_gcode()` checks `.3mf` in `path.suffixes` and uses `_extract_gcode_from_3mf()`.

**OctoPrint shim:** OrcaSlicer → Host Type: OctoPrint, Hostname: backend URL, API Key: JWT. `POST /api/files/local` → parse meta → return highlight URL → frontend auto-opens SendModal.

**Double-submit guard:** `useRef` inFlight guard (not `useState`) for plan actions.

**Encryption:** Fernet key (`ENCRYPTION_KEY`) encrypts Bambu credentials and per-org TG bot tokens in DB. Required in production; skipped in dev.

## Required `.env` variables

```bash
# Core
DATABASE_URL=postgresql+psycopg://printfarm:printfarm@localhost:5432/printfarm
SECRET_KEY=<random 32+ chars>
ENV=development                    # "production" enforces ENCRYPTION_KEY
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<password>

# Encryption (required in production)
ENCRYPTION_KEY=<fernet key>        # python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# Worker mode
INLINE_WORKERS=true                # true for dev; false for multi-worker production

# Bambu Lab (seeds default org; per-org credentials stored encrypted in DB)
BAMBU_EMAIL=<email>
BAMBU_REFRESH_TOKEN=<token>        # preferred for 2FA accounts
BAMBU_REGION=us                    # us | eu | cn

# Telegram (optional — per-org tokens can also be stored in DB)
FARM_PUBLIC_URL=https://your-domain
CORS_ORIGINS=http://localhost:3000,https://your-domain
TIMEZONE=Europe/Kiev

# Redis (empty = in-process dict fallback)
REDIS_URL=rediss://default:<password>@<host>:6379

# S3-compatible storage (empty = local disk at data/gcodes/)
S3_ENDPOINT_URL=https://<account_id>.r2.cloudflarestorage.com
S3_ACCESS_KEY=<key>
S3_SECRET_KEY=<secret>
S3_BUCKET=monofarm-files

# Lemon Squeezy billing (optional)
LMSQ_API_KEY=<key>
LMSQ_WEBHOOK_SECRET=<secret>
LMSQ_STORE_ID=<id>
LMSQ_VARIANT_STARTER=<variant_id>
LMSQ_VARIANT_PRO=<variant_id>
LMSQ_VARIANT_FARM=<variant_id>

# go2rtc camera proxy (optional)
GO2RTC_URL=http://localhost:1984   # empty = disabled
```

## Python version

Python 3.14. Do **not** use `passlib`, `python-jose`, or `psycopg-binary` — all broken on 3.14. Use `bcrypt`, `PyJWT`, `psycopg[binary]>=3.3.0`.

**Tailwind v4 dark mode:** class-based via `@custom-variant dark`. Dev server **must restart** after `globals.css` changes.

**Chrome blocks `http://192.168.x.x`** from localhost. Use Safari for Mainsail links or test from the farm PC.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

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
