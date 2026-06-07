# Codex / Claude Code Prompt — Phase 8: Observability and Bambu Health Diagnostics

Read these first:
- `docs/bambu_cloud_print_implementation_plan.md`
- the implemented Phases 1–7 (schema, auth, dispatch, API refactor, worker/queue, MQTT + state machine, PrintHistory)

Assume that:
- `BambuCloudJob` + `PrintHistory` form a complete lifecycle from request → print → history.
- `bambu_auth.py` owns token lifecycle and legacy fallback.
- `bambu_dispatch.py` handles cloud dispatch with retries and error details.
- `bambu_job_state.py` enforces state transitions and lost detection.
- `bambu.py` maintains printer live state and MQTT correlation.
- `bambu_jobs` and `history` APIs already expose basic job/history info.

Your task: **implement only Phase 8: Observability and Bambu health diagnostics**.
Do NOT change core behavior of auth/dispatch/worker/MQTT/state/history, except where needed to emit structured logs/metrics and wire health data.

---

## Goals

1. Add structured, consistent logging across the Bambu Cloud path for debugging and audits.
2. Introduce basic metrics/instrumentation hooks where the app’s architecture allows.
3. Implement a meaningful `GET /orgs/me/bambu-health` diagnostics endpoint.

---

## Constraints

- Preserve existing behavior and contracts.
- Do NOT break Bambu LAN, Moonraker, or non-Bambu flows.
- Do NOT add heavy dependencies inconsistent with the current stack.
- Do NOT expose secrets (tokens, passwords, email codes) in logs or health responses.
- Keep changes incremental and focused on observability.

---

## Required implementation

### 1. Structured logging for Bambu flows

Identify the main Bambu components:
- `bambu_auth.py`
- `bambu_dispatch.py`
- `bambu_job_state.py`
- `bambu.py` (MQTT / live state)
- `workers/bambu_jobs.py`
- `print_history_bambu.py` (optional, for lifecycle completion logs)

Add structured log calls at key events, following the project’s existing logging pattern (e.g. using the same logger factory, log levels, and context style as other services).

Suggested event names (keys):
- `bambu.auth.login.success`
- `bambu.auth.login.failed`
- `bambu.auth.refresh.success`
- `bambu.auth.refresh.failed`
- `bambu.cloud.job.created`
- `bambu.cloud.job.prepared`
- `bambu.cloud.project.created`
- `bambu.cloud.upload.completed`
- `bambu.cloud.task.created`
- `bambu.cloud.job.failed`
- `bambu.cloud.job.completed`
- `bambu.cloud.job.lost`
- `bambu.mqtt.state.changed`
- `bambu.mqtt.job.acknowledged`
- `bambu.mqtt.job.progress`

Each log entry should include (where available and safe):
- `org_id`
- `printer_id`
- `dev_id`
- `job_id`
- `correlation_id`
- `status` / `old_status` / `new_status`
- `error_code` (if any)

Requirements:
- redact or omit secrets: access tokens, refresh tokens, passwords, verification codes, raw HTTP response bodies that may contain tokens.
- logs should be consistent in structure so they are easy to grep or ship to a log aggregator later.

### 2. Metrics / instrumentation hooks

If the project already has a metrics/telemetry abstraction (e.g. a small wrapper around Prometheus, StatsD, or similar), integrate Bambu flows with it.
If not, create a minimal internal abstraction that can be wired later, e.g.:
- `metrics.increment("bambu.cloud.job.created", tags={...})`
- `metrics.timing("bambu.cloud.dispatch.latency", value, tags={...})`

Do NOT add external dependencies beyond what the project already uses. Favor a lightweight internal interface that can be no-op in environments without metrics.

Suggested counters/timers:
- `bambu.auth.login.success.count`
- `bambu.auth.login.failed.count`
- `bambu.auth.refresh.success.count`
- `bambu.auth.refresh.failed.count`
- `bambu.cloud.job.created.count`
- `bambu.cloud.job.completed.count`
- `bambu.cloud.job.failed.count`
- `bambu.cloud.job.lost.count`
- `bambu.cloud.dispatch.latency.ms`
- `bambu.cloud.upload.latency.ms`
- `bambu.cloud.task_create.latency.ms`

Attach tags where reasonable:
- `org_id`
- `printer_model`
- `region`
- `error_code`

Keep the metrics integration minimal but consistent.

### 3. Bambu health diagnostics endpoint

Implement or extend:
- `GET /orgs/me/bambu-health`

This should return a **diagnostics object** summarizing Bambu Cloud health for the current org.

Suggested response shape (adapt to existing schema style):

```json
{
  "auth": {
    "configured": true,
    "reauth_required": false,
    "last_success_at": "...",
    "last_error": "..."
  },
  "mqtt": {
    "connected": true,
    "last_message_at": "..."
  },
  "printers": {
    "total": 4,
    "bambu_cloud": 3,
    "online": 3,
    "offline": 1
  },
  "jobs": {
    "active": 1,
    "stuck_or_lost": 0,
    "recent_failures": 0
  }
}
```

Requirements:
- Use existing models/services to compute:
  - whether Bambu auth is configured (`bambu_access_token`/`bambu_auth_type` present)
  - whether `bambu_reauth_required` is true
  - last auth success/error timestamps
  - whether MQTT is connected or last-seen status (reuse `bambu.py` state if available)
  - printer counts for the org (total, Bambu-only, online/offline)
  - job counts (active non-terminal, lost, recent failures within a time window)
- Do NOT expose raw access tokens, refresh tokens, or sensitive error payloads.
- The endpoint should be cheap enough to call from an admin UI periodically.

Add a corresponding Pydantic schema for the health response, e.g. `BambuHealthOut`, and integrate it into the appropriate API module (likely `api/bambu_jobs.py` or `api/orgs.py`, depending on where the earlier stub was placed).

### 4. Minimal tests

Add tests to validate:
- key log events are emitted at least in critical flows (you can assert via a test logger or monkeypatching the logger in unit tests).
- the health endpoint returns a structurally valid payload for an org with:
  - configured auth
  - no auth
  - reauth_required = true
- the health endpoint correctly reflects basic job and printer counts based on seeded fixtures.

Follow existing patterns for unit vs integration tests in the repo.

---

## Non-goals in this phase

Do NOT implement yet:
- a complete external metrics backend wiring (Prometheus, Grafana, etc.) if not already present.
- webhook callbacks or external alerting integrations.
- changes to auth/dispatch/worker/MQTT control flow beyond what is necessary to log/measure.

---

## Deliverables

1. Structured logs across key Bambu auth/dispatch/worker/MQTT/history flows.
2. Lightweight metrics hooks for Bambu Cloud operations.
3. A useful `GET /orgs/me/bambu-health` endpoint with a clear schema.
4. Tests validating logs/health basics and non-regression.

---

## Output format

When done, respond with:
1. Summary of observability and health features added.
2. Exact files changed.
3. Example log events and example /bambu-health response payload.
4. Risks / follow-ups for Phase 9.
