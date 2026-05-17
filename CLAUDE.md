# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Claude Code harness:** team config lives in [`.claude/`](.claude/CLAUDE.md) (`rules/`, `commands/`, `agents/`, shared `settings.json`). Slash workflows: `/backend-test`, `/frontend-check`, `/graphify-refresh`. Optional private notes in `CLAUDE.local.md` (gitignored).

## Project overview

Full-stack 3D print farm management platform ("printfarm"). Manages ~50 printers: SimplyPrint-connected printers (live state from SimplyPrint API), 12 Snapmaker U1 printers tracked via Moonraker/Klipper REST, and Bambu Lab printers (P1S, A1, A1 mini) via Cloud MQTT + LAN FTPS. Two operators with shifts, a remote manager, daily print planning, farm task management, and filament inventory.

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

# Run API
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
pip install -r requirements-dev.txt              # pytest, httpx, ruff
docker exec printfarm-db psql -U printfarm -d postgres \
  -c "CREATE DATABASE printfarm_test"            # one-time
pytest                                            # all tests (unit + integration)
pytest tests/unit -q                              # unit only (no DB needed)
ruff check .                                      # lint
```

Tests use a separate `printfarm_test` Postgres database. Override with
`TEST_DATABASE_URL=...`. Schema is created from SQLAlchemy models
(`Base.metadata.create_all`) once per session; each test runs inside a
transaction that's rolled back on teardown. External services (SimplyPrint,
Bambu Cloud, Moonraker, Telegram) are mocked at the fixture level — tests
never touch the network. The FastAPI lifespan is NOT executed in tests
(we never use `with TestClient(...)`), so the scheduler / Bambu MQTT /
Telegram long-poll never start. CI: `.github/workflows/ci.yml`.

## Architecture

**Backend** (`backend/app/`):
- `main.py` — FastAPI app; lifespan manages APScheduler (09:00 Kyiv daily report), Telegram bot long-polling, and Bambu MQTT client in the same asyncio event loop. Routers: auth, printers, tasks, farm_tasks, plan, filaments, files, octoprint, users.
- `core/security.py` — PyJWT + bcrypt directly (not passlib/python-jose, both broken on Python 3.14).
- `api/deps.py` — `HTTPBearer` scheme (not OAuth2PasswordBearer) so Swagger /docs shows a raw token input field.
- `api/printers.py` — `list_printers` is **async** and parallelizes SimplyPrint, Bambu Cloud, and Moonraker status fetches via `asyncio.gather`. `_ensure_bambu_rows()` auto-imports Bambu printers from cloud. `_to_dto()` dispatches to SP/Bambu/Moonraker/manual branches. `_dispatch()` routes pause/resume/cancel to the right backend (SP, Moonraker, or Bambu MQTT).
- `api/files.py` — central gcode/3mf storage at `data/gcodes/<uuid>.<ext>`. Endpoints: list, upload (parses filament_meta), download, delete, **send to printer with slot remapping**. For Moonraker: `slot_map` triggers gcode T-command rewrite via `moonraker.remap_slots()`. For Bambu: `slot_map` is converted to `ams_mapping` list and passed in the MQTT `project_file` command (no file rewrite). Bambu only accepts `.3mf` files.
- `api/octoprint.py` — **OctoPrint API shim** for OrcaSlicer integration. Implements `GET /api/version`, `GET /api/printer`, `POST /api/files/local`. Auth via `X-Api-Key` header containing the user's JWT. Returns `url` field pointing to `FARM_PUBLIC_URL/files?highlight=<id>` so OrcaSlicer's "Device" tab opens the frontend file page (configure Device UI URL = frontend, Hostname = backend).
- `services/moonraker.py` — sync `requests` calls to Moonraker REST API, called via `asyncio.to_thread`. Two caches: `_status_cache` (10s TTL per URL) and `_meta_cache` (300s TTL per URL+filename). `STATUS_TIMEOUT=3s` for live polling. `get_remote_file_meta()` tries `GET /server/files/metadata?filename=X` first, then falls back to Range-downloading the last 96KB of the file. **`remap_slots(src, slot_map)`** rewrites tool-change commands (`T0`, `T1`, etc., including in `M104/M109/M116 T<n>` params) using a two-pass placeholder strategy to handle slot swaps without collisions.
- `services/gcode_meta.py` — parses slicer comments from gcode head+tail: `filament_colour`, `filament_type`, per-slot weights, `estimated_time`, layer count. **Supports `.3mf` / `.gcode.3mf`**: opens the ZIP and extracts `Metadata/plate_N.gcode` (OrcaSlicer/Bambu format). Works for PrusaSlicer, OrcaSlicer, Snaporca, Bambu Studio.
- `services/bambu.py` — Bambu Lab Cloud HTTP (login/refresh/list_devices via sync `requests`) + paho-mqtt singleton (background thread, TLS :8883) for live status and commands + `ftplib.FTP_TLS` for LAN .3mf upload. `_state_cache[dev_id]` holds latest MQTT report; `_ams_cache[dev_id]` holds AMS tray data. Token auto-refreshes every 6h via APScheduler.
- `services/simplyprint.py` — 30s-cached GET to SimplyPrint GetFarmOverview. Tolerates multiple response shapes.
- `services/telegram_bot.py` — PTB 21+ embedded in FastAPI lifespan. Cyrillic commands (`/план`, `/статус`, etc.) registered via `MessageHandler(Regex(...))` not `CommandHandler` (PTB rejects non-ASCII command names at startup). Magic-link `/start <code>` for account linking.
- `services/daily_report.py` — `build_status_text()` and `build_daily_report()` for 09:00 broadcast to all users with `telegram_chat_id`.

**Frontend** (`frontend/src/`):
- Next.js 16 App Router, Tailwind v4, Bun.
- `app/globals.css` — `@custom-variant dark (&:where(.dark, .dark *))` for class-based dark mode. **Requires `bun run dev` restart after any change to this file.**
- `app/layout.tsx` — inline `<script>` in `<head>` applies `.dark` class before hydration to prevent flash. `suppressHydrationWarning` on `<html>`.
- `lib/api.ts` — `api<T>(path, init?)` wrapper that injects JWT from localStorage and throws `ApiError` on non-2xx. **Skips `Content-Type: application/json` when body is `FormData`** (browser sets multipart boundary).
- `lib/auth-context.tsx` — React context providing current user; `useUser()` hook.
- `app/(app)/files/page.tsx` — file library page. Auto-opens `SendModal` after upload OR when navigated with `?highlight=<id>` (from OrcaSlicer). `SendModal` shows per-printer slot compatibility (✓/~/✕ badges based on `loaded_filaments` vs file `filament_meta`) and a slot-remap dropdown that builds a `slot_map` for the API.
- `app/(app)/tasks/page.tsx` — kanban with `flex-1 min-w-56` columns so they fill available width.
- `app/(app)/plan/page.tsx` — labeled "План друку" in the topbar (was "План дня").

**Data model** (PostgreSQL 16, SQLAlchemy 2 `Mapped`):
- `Printer` — `kind: PrinterKind` (simplyprint | snapmaker_u1 | bambu | other), `sp_printer_id`, `moonraker_url`, `bambu_dev_id/bambu_access_code/bambu_dev_ip/bambu_model` for Bambu Lab, `manual_status/job/eta_minutes` for non-API manual tracking. `loaded_filaments: JSONB` array of `{slot, color, type, color_name, brand?, filament_id?}` (slot is **0-based** in DB). For Bambu, AMS trays are auto-populated from MQTT reports.
- `PrintTask` — `filament_meta: JSONB` (FilamentMeta: types, colors, used_g, estimated_minutes, total_layers, layer_height).
- `PlanEntry` — join between Printer and PrintTask for a given day; cascade-deleted when printer is deleted.
- `Filament` — inventory rows with `grams_remaining`, `min_grams`, `is_low` computed property.
- `GcodeFile` — central file storage. `stored_name` (UUID-based on disk), `original_name`, `size_bytes`, `filament_meta: JSONB` (parsed at upload time), `uploaded_by_id`. Files live at `backend/data/gcodes/<stored_name>`.
- `User` — roles: admin/operator/manager; `telegram_chat_id` for Telegram linking.

## Critical conventions

**Moonraker URL handling:** `_api_base(url)` strips path and `?printer=<hash>` query params (Mainsail UI bookkeeping). Always pass raw user-entered URLs through `_api_base()` before calling Moonraker endpoints.

**Printer state vocabulary:** Moonraker `print_stats.state` values are normalized via `_STATE_MAP` in `moonraker.py`; Bambu `gcode_state` values (IDLE/RUNNING/PAUSE/FINISH/FAILED) via `_GCODE_STATE_MAP` in `bambu.py` → our unified states: `idle`, `printing`, `paused`, `operational`, `error`, `offline`, `unknown`.

**Filament metadata fallback chain** (in `api/printers.py:_resolve_filament_for_file`):
1. Local DB: `PrintTask` with matching `file_name` and non-null `filament_meta`.
2. Moonraker `/server/files/metadata` (parses slicer comments server-side).
3. Range-download last 96KB of file + local `gcode_meta.parse_gcode()`.

**SimplyPrint printers** are auto-imported into the DB on first `GET /api/printers` call (`_ensure_simplyprint_rows`). Never manually create SimplyPrint rows — names sync from the API.

**Bambu Lab printers** are auto-imported via `_ensure_bambu_rows()` from Bambu Cloud `list_devices`. MQTT subscription happens on discovery. Live state comes from MQTT `device/{dev_id}/report` topic (cached in `bambu._state_cache`). AMS tray data is parsed from `ams.ams[N].tray[M]` in MQTT reports. File upload uses LAN FTPS (:990, user `bblp`, password = access_code). Print start uses MQTT `project_file` command with `ams_mapping`.

**Moonraker cache invalidation:** After pause/resume/cancel actions, `_status_cache.pop(url)` is called explicitly so the next poll returns fresh state.

**Slot indexing:** Internally everything is **0-based** (T0/T1/T2/T3 in gcode, slot 0..3 in `loaded_filaments`, slot_map in API). UI displays as **1-based** (Slot 1..4) — convert at render time only, never in storage. The API contract (`POST /api/files/{id}/send/{printer_id}` body `{slot_map: {0: 1, 1: 0}}`) uses 0-based on both sides.

**Slot remapping algorithm:** For Moonraker printers: `moonraker.remap_slots(src, slot_map)` reads the gcode, regex-matches `T<n>` at line start AND inside `M104/M109/M116 T<n>` parameters, replaces with `__TOOL_<n>__` placeholders in pass 1, then substitutes placeholders with target slot numbers in pass 2. This avoids A→B then B→A collision when slots are swapped. Only invoked when `any(k != v for k, v in slot_map.items())` — identity maps skip the rewrite entirely. For Bambu printers: no file rewrite — `slot_map` is converted to `ams_mapping` list and passed in the MQTT `project_file` command.

**OctoPrint integration for OrcaSlicer:** OrcaSlicer Physical Printer settings — Host Type: OctoPrint, Hostname: `http://localhost:8000` (backend), API Key: user's JWT token, Device UI URL: `http://localhost:3000` (frontend). On upload, `POST /api/files/local` parses filament_meta and returns the highlight URL. Frontend `/files?highlight=<id>` auto-opens `SendModal` for one-click sending.

**3MF extension handling:** `.gcode.3mf` is a double extension — `Path(name).suffix` returns only `.3mf`. We use `"".join(p.suffixes)` to preserve the full extension when storing. `parse_gcode()` checks for `.3mf` in `path.suffixes` (not just `.suffix`) and uses `_extract_gcode_from_3mf()` (zipfile) before falling through to flat-file parsing.

**Parallel printer fetch:** `list_printers` runs SimplyPrint overview, Bambu `list_devices`, and Moonraker status calls in parallel via `asyncio.gather`. Moonraker uses `asyncio.gather(*[asyncio.to_thread(...) for r in moonraker_rows], return_exceptions=True)` — failed/timeout requests yield `{"state": "offline"}`. Bambu state comes from MQTT cache (no per-request network call).

**Double-submit guard on plan actions:** Use a `useRef` inFlight guard (not `useState`) to prevent duplicate API calls from rapid clicks.

**Required `.env` variables** (in `backend/`):
```
DATABASE_URL=postgresql+psycopg://printfarm:printfarm@localhost:5432/printfarm
SECRET_KEY=<random>
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<password>
SIMPLYPRINT_API_KEY=<key>          # optional; SP printers won't show without it
SIMPLYPRINT_ORG_ID=<org_id>        # optional
BAMBU_EMAIL=<email>                # optional; Bambu printers won't show without creds
BAMBU_PASSWORD=<password>          # or use BAMBU_REFRESH_TOKEN instead
BAMBU_REFRESH_TOKEN=<token>        # from Bambu Studio config; preferred for 2FA accounts
BAMBU_REGION=us                    # us | eu | cn
TG_BOT_TOKEN=<token>               # optional; Telegram features disabled without it
FARM_PUBLIC_URL=https://your-domain  # used in magic-link URLs sent via Telegram
CORS_ORIGINS=http://localhost:3000,https://your-domain
```

**Python version:** 3.14. Do not use `passlib`, `python-jose`, or `psycopg-binary` (pinned version) — all broken on 3.14. Use `bcrypt` directly, `PyJWT`, `psycopg[binary]>=3.3.0`.

**Tailwind v4 dark mode:** Class-based via `@custom-variant dark`. The dev server **must be restarted** after any change to `globals.css` — hot reload doesn't pick up `@custom-variant` changes.

**Chrome blocks `http://192.168.x.x`** from localhost (Private Network Access policy). Use Safari for testing Mainsail links, or test on the farm PC directly.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

On this machine Graphify is installed in `.venv-graphify`. Run `. .venv-graphify/bin/activate` before `graphify` / `graphify query` / etc.

Rules:
- ALWAYS read graphify-out/GRAPH_REPORT.md before reading any source files, running grep/glob searches, or answering codebase questions. The graph is your primary map of the codebase.
- IF graphify-out/wiki/index.md EXISTS, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
