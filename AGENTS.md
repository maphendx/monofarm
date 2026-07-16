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
| `/warehouse` | warehouse.py | full ERP — see Warehouse module |
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
- `scheduler.py` — APScheduler: daily 09:00 Kyiv report, Bambu token refresh.
- `print_tracker.py` — tracks active jobs, writes `PrintHistory` on completion.
- `tunnel.py` — WebSocket manager for farm agents (JWT auth, proxy HTTP to local Moonraker).
- `go2rtc.py` — camera stream proxy via go2rtc sidecar (`GO2RTC_URL`).
- `bootstrap.py` — seeds admin user + default org on first start.

## Warehouse module (`api/warehouse.py`, `models/warehouse.py`)

Categories → Products (SKU, barcode, cost/sale price, thresholds; CSV import/export) → Specifications (BOM: components + operations) → Stock per warehouse → Movements ledger (PURCHASE_IN / SALE_OUT / RETURN_IN / TRANSFER / ADJUSTMENT / PRODUCTION_IN / PRODUCTION_OUT / WRITE_OFF) → Production Batches (open/close writes production movements) → Orders (reserve → ship → SALE_OUT; source: manual/keycrm) → Counterparties (balance tracking) → Cash Flow → Analytics. Warehouses (physical/virtual/consignment) have Zones → Cells → CellStock; invariant sum(cells) ≤ StockEntry.qty.

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
