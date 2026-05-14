# Tech debt & SaaS migration notes

This file tracks known gaps that block (a) confident scaling of the current
single-tenant farm deployment and (b) eventual conversion of printfarm to a
multi-tenant SaaS product. Each item describes **what** is wrong, **why it
matters at scale**, and a sketch of the **fix**.

Keep this list short and current. When an item is fixed, remove it.

---

## A. Multi-tenancy (blocks SaaS)

The current data model assumes a single organization. Every printer, user, file
and filament row is global. Converting to SaaS requires an `Organization` (or
`Tenant`, `Workspace`) entity and `organization_id` FKs on every domain row,
plus scoped queries in every endpoint.

### A1. No tenant scoping in models
**Where:** `backend/app/models/*.py` — `Printer`, `User`, `GcodeFile`,
`Filament`, `FilamentColor`, `PrinterGroup`, `PrintTask`, `FarmTask`,
`PlanEntry` all lack `organization_id`.

**Why it matters:** Any tenant could read or modify another tenant's printers,
files, jobs. Catastrophic at SaaS launch.

**Fix sketch:**
1. Create `Organization` model + `users.organization_id` FK + invite/join flow.
2. Add `organization_id` to every domain table (Alembic migration with
   `nullable=False` after backfill).
3. Add a `CurrentOrg` dependency in `api/deps.py` that resolves from the JWT
   (embed `org_id` claim in `create_access_token`).
4. Refactor every query in `app/api/*.py` to `.filter(Model.organization_id ==
   org.id)`. **High-risk step — needs systematic audit, ideally via a base
   class or query helper that fails closed.**

### A2. Global integration credentials in environment
**Where:** `backend/app/core/config.py` → `SIMPLYPRINT_API_KEY`,
`SIMPLYPRINT_ORG_ID`, `BAMBU_EMAIL`, `BAMBU_PASSWORD`, `BAMBU_REFRESH_TOKEN`,
`TG_BOT_TOKEN`.

**Why it matters:** Every tenant would share the same SimplyPrint org and
Bambu Cloud account. Impossible to onboard a second tenant.

**Fix sketch:** Move all integration credentials into a per-organization
`Integration` table (encrypted at rest — see C2). The Bambu MQTT singleton in
`services/bambu.py` becomes a per-org client pool keyed by `organization_id`;
same for SimplyPrint's cached overview.

### A3. Telegram bot is single-tenant
**Where:** `backend/app/services/telegram_bot.py` — embedded in FastAPI
lifespan as a global long-polling client.

**Why it matters:** Each tenant would need its own bot token. Cyrillic command
handlers and magic-link `/start` flow assume one bot.

**Fix sketch:** Two options — (1) one shared bot, route messages by linking
`telegram_chat_id` to a `(user_id, org_id)` pair (works, but tenants share the
bot's @username), or (2) webhook mode + per-tenant bot tokens (cleaner brand,
needs HTTPS endpoints). Webhook mode also fixes the long-polling cost at scale.

### A4. Daily report scheduler is global
**Where:** `backend/app/services/scheduler.py` + `services/daily_report.py` —
single APScheduler job at 09:00 Kyiv time for all users.

**Why it matters:** Different tenants live in different timezones. One job at
one time doesn't scale.

**Fix sketch:** Per-org scheduled job, or a single hourly job that picks orgs
whose local time is 09:00. Move `TIMEZONE` from env to `Organization.timezone`.

### A5. File storage is on a single local disk
**Where:** `backend/app/api/files.py` → `GCODES_DIR = backend/data/gcodes/`.

**Why it matters:** Doesn't scale past one VM; no per-tenant quotas; no backup
isolation; cross-tenant data leak if `stored_name` collides.

**Fix sketch:** S3-compatible blob storage (Tigris, R2, S3) with a per-tenant
prefix `{org_id}/{file_id}`. Replace `FileResponse` with presigned URLs.
Enforce a per-tenant byte quota at upload time (cheap — sum `size_bytes`
per `organization_id`).

---

## B. Scaling concerns (independent of SaaS)

### B1. In-process Bambu MQTT + APScheduler + Telegram in FastAPI lifespan
**Where:** `backend/app/main.py:35-62`.

**Why it matters:** Currently all three live inside the FastAPI process via
`lifespan`. Behavior under multiple workers (`uvicorn --workers N`) is
undefined: every worker runs its own scheduler → duplicate jobs; every worker
subscribes to MQTT → duplicate state caches; only one worker can long-poll
Telegram at a time. Today this works because production runs a single worker.

**Fix sketch:** Split into worker process types — `web` (FastAPI), `mqtt`
(Bambu), `scheduler` (APScheduler + Telegram). Persist scheduler jobs in
Postgres (APScheduler supports `SQLAlchemyJobStore`) and use Postgres advisory
locks so only one scheduler instance fires each job.

### B2. In-memory caches that don't survive restarts or scale across workers
**Where:**
- `services/moonraker.py` → `_status_cache`, `_meta_cache`
- `services/simplyprint.py` → 30s cache
- `services/bambu.py` → `_state_cache`, `_ams_cache`

**Why it matters:** Restarts cause UI to show "offline" briefly. Multi-worker
deployments have inconsistent caches per worker.

**Fix sketch:** Redis for shared cache layer. Already needed for B1.

### B3. No request rate limiting
**Why it matters:** No protection against credential-stuffing on `/api/auth/
login`, no per-tenant quotas on `/api/files/upload`. Easy DoS.

**Fix sketch:** `slowapi` (FastAPI-friendly) or an upstream layer (Cloudflare,
nginx). Strictness should be per-tenant when SaaS arrives.

### B4. No structured request logging or error reporting
**Why it matters:** When things break in production, root-cause analysis
relies on operator memory. Won't scale past today's two-operator team.

**Fix sketch:** Sentry for exceptions, structured JSON logs (`structlog`) +
log shipping (Loki/Grafana, or hosted equivalent).

### B5. SimplyPrint / Bambu sync is on the request path
**Where:** `app/api/printers.py:list_printers` triggers SimplyPrint API call,
Bambu Cloud `list_devices`, and per-printer Moonraker polls every time the
dashboard is opened.

**Why it matters:** Latency and rate-limit risk grow linearly with farm size
and dashboard tab count. Currently parallelized via `asyncio.gather` but
still synchronous w.r.t. the request.

**Fix sketch:** Background sync task writes state into a `printer_state`
table; API reads from DB only. This also enables websocket push for live
state instead of polling.

---

## C. Security gaps

### C1. JWT has no refresh / revocation
**Where:** `core/security.py` — tokens are valid for `ACCESS_TOKEN_EXPIRE_MINUTES`
(default 30 days). No way to revoke a compromised token without rotating
`SECRET_KEY` (which logs out everyone).

**Fix sketch:** Short-lived access tokens (15 min) + opaque refresh tokens
stored server-side, revocable per user.

### C2. Integration credentials stored in plaintext (.env today, DB after A2)
**Why it matters:** `BAMBU_PASSWORD`, `SIMPLYPRINT_API_KEY` end up in a DB
column once A2 lands. Plaintext = full compromise if the DB is dumped.

**Fix sketch:** Symmetric encryption at the application layer (`cryptography`
`Fernet` keyed off an env-only master secret), or KMS-backed envelope
encryption when SaaS launches.

### C3. CORS is wildcard-ish in dev
**Where:** `core/config.py` defaults to a comma-separated list; CORS middleware
allows `allow_methods=["*"]`, `allow_headers=["*"]`, `allow_credentials=True`.

**Why it matters:** OK for dev. In SaaS production with per-tenant subdomains,
this should be a function `(origin) → bool` that allows the tenant's own
subdomain only.

### C4. OctoPrint shim accepts JWT as `X-Api-Key`
**Where:** `app/api/octoprint.py` — OrcaSlicer needs an API-key shaped header,
so we accept the raw JWT there.

**Why it matters:** API keys are typically long-lived and copy-pasted into
slicer configs. Today that means a 30-day JWT sitting in OrcaSlicer's plain-
text preferences. If leaked, attacker gets full account access until expiry.

**Fix sketch:** Issue separate, scope-limited API keys (e.g. `files:upload`)
per user/integration. Store as hashed values. Treat JWT and API key as
distinct credential types.

---

## D. Codebase hygiene (smaller, can fix opportunistically)

### D1. Frontend: 16 lint errors from Next 16 / React 19 strict rules
**Where:** `frontend/src/components/*.tsx`,
`frontend/src/app/(app)/**/page.tsx`.

**What:** `react-hooks/set-state-in-effect` flags 14+ legacy patterns; a
couple of `no-unused-vars` warnings.

**Why it matters:** CI lint runs in advisory mode (does not fail builds) for
now. Long-term these patterns can cause cascading re-renders under React
Concurrent rendering.

**Fix sketch:** Migrate offending `useEffect` hooks to event handlers, `useMemo`,
or `useSyncExternalStore` where appropriate. Once clean, flip
`continue-on-error: false` in `.github/workflows/ci.yml`.

### D2. Pydantic v2 class-based Config still used
**Where:** every `app/schemas/*.py` uses `class Config: from_attributes = True`
instead of `model_config = ConfigDict(from_attributes=True)`.

**Why it matters:** Pydantic v3 removes class-based config. Will break on
the next major upgrade.

**Fix sketch:** Mechanical rewrite across all schemas — one PR.

### D3. No frontend tests
**Why it matters:** Refactors of UI components (SendModal, PrinterCard) have
no safety net. Component-level bugs only surface in manual testing.

**Fix sketch:** Vitest + React Testing Library for the highest-value
components: `SendModal` (slot-remap logic), `PrinterCard` (state rendering),
`PrinterDetailModal`. Defer Playwright e2e until critical flows are stable.

### D4. Bambu MQTT singleton state leaks between tests
**Where:** `services/bambu.py` keeps `_state_cache` and `_ams_cache` as
module-level dicts.

**Why it matters:** Integration tests already mock the calls, but if we ever
add tests that touch the actual MQTT client, between-test isolation will
break. Same applies if you ever run two Bambu connections in one process
(e.g. multiple tenants).

**Fix sketch:** Replace module-level dicts with a `BambuClient` class
instance held in `app.state`. Tests can swap the instance per test.
