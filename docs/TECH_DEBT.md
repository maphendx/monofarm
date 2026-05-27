# Tech debt & SaaS migration notes

This file tracks known gaps that block (a) confident scaling of the current
single-tenant farm deployment and (b) eventual conversion of printfarm to a
multi-tenant SaaS product. Each item describes **what** is wrong, **why it
matters at scale**, and a sketch of the **fix**.

Keep this list short and current. When an item is fixed, remove it.

---

## A. Multi-tenancy (blocks SaaS)

### A1. ✅ Tenant scoping — DONE

`Organization` model + `organization_id` FK on all tables + `get_current_org` dependency + scoped queries in every endpoint. Migration `0012_organizations`.

### A2. ✅ Per-org Bambu credentials — DONE

`bambu_email`, `bambu_password`, `bambu_refresh_token`, `bambu_region` stored in `Organization` table. Env vars seed the default org only.

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

### A5. ✅ File storage — DONE

`services/storage.py` — local disk when `S3_BUCKET` empty, Cloudflare R2 (boto3 S3-compatible) when configured. Key pattern `orgs/{org_id}/gcodes/{stored_name}`. Download endpoint redirects to presigned URL for S3. Per-tenant quota enforcement still TODO (sum `size_bytes` per org).

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

### B2. ✅ Shared Redis cache — DONE

`services/cache.py` — Redis (`REDIS_URL`) with in-process dict fallback. Moonraker status (10s) + meta (300s) and Bambu state (30s) + AMS (300s) all go through Redis. Cross-worker consistent. Local dicts kept as stale fallback on network errors.

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
