# AGENTS.md

AI agent context for Codex, Gemini CLI, and other AI coding tools.

## Project overview

Full-stack 3D print farm management SaaS ("monofarm"). Multi-tenant: each customer gets an isolated `Organization`. Manages printers via Moonraker/Klipper REST (Snapmaker U1) and Bambu Lab (P1S, A1, A1 mini) via Cloud MQTT + LAN FTPS. Daily print planning, farm task management, filament inventory, warehouse/ERP module. Billing via Lemon Squeezy.

**Stack:** FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL 16 | Next.js 16 App Router + Tailwind v4 + Bun | Redis | S3/R2 | python-telegram-bot 21+

## Repo structure

```text
backend/        FastAPI app (app/api, app/models, app/services, app/core)
frontend/       Next.js (src/app, src/components, src/lib)
agent/          Local farm agent (WebSocket tunnel + Bambu camera)
bruno/          Bruno API collection
docs/           Architecture docs
```

## Commands

```bash
# Backend
cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
docker compose up -d            # postgres:16 on :5432
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend && bun install && bun run dev   # :3000

# Tests
cd backend && pytest
ruff check .

# New migration
alembic revision --autogenerate -m "description"
```

## Backend routers (all under `/api`)

| Prefix | Router | Purpose |
| --- | --- | --- |
| `/auth` | auth.py | login, register, me |
| `/users` | users.py | CRUD, Telegram link |
| `/orgs` | orgs.py | org settings, Bambu credentials |
| `/api-keys` | api_keys.py | long-lived API keys |
| `/printers` | printers.py | list (parallel), CRUD, controls |
| `/printer-groups` | printer_groups.py | grouping + reorder |
| `/tasks/print` | tasks.py | print task kanban |
| `/tasks/farm` | farm_tasks.py | farm task kanban |
| `/plan` | plan.py | daily plan |
| `/filaments` | filaments.py | inventory, FilamentLog |
| `/filament-colors` | filament_colors.py | color palette |
| `/files` | files.py | gcode/3mf library + send |
| `/folders` | files.py (folders_router) | folder CRUD |
| `/history` | history.py | print history |
| `/analytics` | analytics.py | charts and stats |
| `/warehouse` | warehouse.py | full ERP module |
| `/keycrm` | keycrm.py | KeyCRM webhook (HMAC-SHA256) |
| `/api/billing` | billing.py | Lemon Squeezy |
| `/api/agent` | agent.py + agent_tg.py | farm agent WebSocket + TG proxy |
| `/api` | octoprint.py | OctoPrint shim for OrcaSlicer |

## Warehouse module (`/api/warehouse`)

Categories → Products (SKU, barcode, specs/BOM) → Stock (per warehouse) → Movements (PURCHASE_IN / SALE_OUT / RETURN_IN / TRANSFER / ADJUSTMENT / PRODUCTION_IN / PRODUCTION_OUT / WRITE_OFF) → Production Batches → Orders (reserve → ship) → Counterparties → Cash Flow → Analytics. Warehouses have Zones → Cells → CellStock.

## Key models

**Print farm:** `Printer`, `PrintTask`, `FarmTask`, `PlanEntry`, `PrintHistory`, `PrinterGroup`, `Filament`, `FilamentLog`, `FilamentColor`, `GcodeFile`, `GcodeFolder`, `ApiKey`

**Org:** `Organization` (plan: free|starter|pro|farm, encrypted Bambu/TG credentials), `User` (roles: admin|operator|manager)

**Warehouse:** `ProductCategory`, `Product`, `Specification`, `SpecComponent`, `SpecOperation`, `StockEntry`, `WarehouseMovement`, `ProductionBatch`, `Order`, `OrderItem`, `Counterparty`, `CashTransaction`, `Warehouse`, `WarehouseZone`, `WarehouseCell`, `CellStock`

## Frontend pages (`app/(app)/`)

`/dashboard`, `/printers/[id]`, `/tasks`, `/plan`, `/files`, `/filament`, `/history`, `/analytics`, `/users`, `/settings`, `/warehouse` and sub-pages: `products`, `products/[id]`, `stock`, `movements`, `orders`, `production`, `assembly`, `categories`, `counterparties`, `cashflow`, `warehouses`, `warehouses/[id]`, `specs`, `analytics`

## Components structure (`src/components/`)

`ui/` `layout/` `printers/` `dashboard/` `filament/` `files/` `users/` `labels/` `plan/` `queue/` `warehouse/`

Never add components to the components root — always use a subfolder.

## Critical conventions

- **Slot indexing:** 0-based in DB/gcode/API; 1-based in UI only
- **Slot remapping:** two-pass placeholder rewrite (`T<n>` → `__TOOL_<n>__` → target) to avoid swap collisions
- **Worker separation:** `INLINE_WORKERS=false` in production; separate worker process for Telegram/Scheduler/Bambu MQTT
- **Moonraker URLs:** always pass through `_api_base(url)` to strip Mainsail query params
- **Printer states:** unified vocabulary — `idle`, `printing`, `paused`, `operational`, `error`, `offline`, `unknown`
- **Encryption:** Fernet (`ENCRYPTION_KEY`) for Bambu credentials and per-org TG tokens; required in production
- **Python 3.14:** do not use `passlib`, `python-jose`, `psycopg-binary` — broken. Use `bcrypt`, `PyJWT`, `psycopg[binary]>=3.3.0`
- **Tailwind v4:** restart dev server after any `globals.css` change
- **3MF extension:** use `"".join(p.suffixes)` not `p.suffix` for `.gcode.3mf`
- **Migrations:** sequential naming `0001_`, `0002_` etc — never leave auto-generated UUID names

## Required `.env`

```bash
DATABASE_URL=postgresql+psycopg://...
SECRET_KEY=<random>
ENV=development                 # "production" requires ENCRYPTION_KEY
ENCRYPTION_KEY=<fernet key>
INLINE_WORKERS=true             # false in multi-worker production
BAMBU_EMAIL=<email>
BAMBU_REFRESH_TOKEN=<token>
BAMBU_REGION=us
FARM_PUBLIC_URL=https://your-domain
CORS_ORIGINS=http://localhost:3000
REDIS_URL=rediss://...
S3_ENDPOINT_URL=https://...
S3_ACCESS_KEY=<key>
S3_SECRET_KEY=<secret>
S3_BUCKET=monofarm-files
LMSQ_API_KEY=<key>
LMSQ_WEBHOOK_SECRET=<secret>
LMSQ_STORE_ID=<id>
GO2RTC_URL=http://localhost:1984
```
