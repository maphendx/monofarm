# Codex / Claude Code Prompt — Phase 9: Bambu Error Taxonomy and Polishing

Read these first:
- `docs/bambu_cloud_print_implementation_plan.md`
- the implemented Phases 1–8 (schema, auth, dispatch, API refactor, worker/queue, MQTT + state machine, PrintHistory, observability/health)

Assume that:
- Bambu Cloud print pipeline is end-to-end functional.
- `BambuCloudJob.error_code` and `error_details_json` exist and are written in some places.
- Structured logs and metrics hooks already exist (Phase 8).
- Health endpoint and diagnostics are in place.

Your task: **implement only Phase 9: Bambu error taxonomy and error-handling polish**.
This is a refinement phase: make errors consistent, explicit, and easy to reason about across the whole Bambu Cloud stack.

---

## Goals

1. Define a centralized Bambu error taxonomy (codes, classes, retryability).
2. Use this taxonomy consistently in auth, dispatch, worker, MQTT/state machine, and history.
3. Surface error codes and safe messages through logs, metrics, jobs, and health where appropriate.

---

## Constraints

- Preserve current behavior as much as possible; this is a refactor/normalization pass.
- Do NOT break successful paths or retry behavior from earlier phases.
- Do NOT leak secrets (tokens, passwords, email codes, raw Bambu responses) in error messages or logs.
- Do NOT change public API request contracts beyond adding optional error-code fields where helpful.

---

## Required implementation

### 1. Central error taxonomy module

Create a new module, for example:
- `backend/app/services/bambu_errors.py`

Define:
- an enum or a small class hierarchy for Bambu error codes, e.g.:
  - `AUTH_INVALID`
  - `AUTH_EXPIRED`
  - `AUTH_REAUTH_REQUIRED`
  - `REGION_MISMATCH`
  - `DEVICE_NOT_FOUND`
  - `DEVICE_OFFLINE`
  - `MQTT_NOT_CONNECTED`
  - `MQTT_ACK_TIMEOUT`
  - `PROJECT_CREATE_FAILED`
  - `OSS_UPLOAD_FAILED`
  - `TASK_CREATE_FAILED`
  - `PRINT_FAILED_HMS`
  - `PRINT_CANCELLED_BY_USER`
  - `RETRY_EXHAUSTED`
  - `INVALID_3MF`
  - `IDEMPOTENCY_REPLAY`
- a small mapping structure or helpers:
  - `is_retryable(error_code) -> bool`
  - `to_user_message(error_code) -> str` (safe, high-level text)
  - `to_technical_message(error_code) -> str` (for logs/diagnostics, still redacted)

Keep this module self-contained and easy to extend.

### 2. Wire taxonomy into existing exceptions and job errors

Review and update Bambu-related code to use the taxonomy consistently:
- `bambu_auth.py` (auth/login/refresh errors)
- `bambu_dispatch.py` (project/upload/task failures, validation errors, auth failures during dispatch)
- `workers/bambu_jobs.py` (retry exhaustion, worker-level failures)
- `bambu.py` / `bambu_job_state.py` (MQTT/ack timeouts, lost jobs)
- `print_history_bambu.py` (mapping final job error into history result_reason)

Requirements:
- when a Bambu failure occurs, set `BambuCloudJob.error_code` to one of the defined taxonomy codes
- populate `error_details_json` with:
  - `error_code`
  - minimal extra context (HTTP status, short Bambu message, stage, retry_count), without secrets
- make sure `retryable` logic in worker/dispatch is aligned with `is_retryable(error_code)`

Examples:
- 401 with bad credentials from login → `AUTH_INVALID`
- 401/403 due to expired token → `AUTH_EXPIRED`
- refresh/login repeatedly failing → `AUTH_REAUTH_REQUIRED`
- offline printer at dispatch time → `DEVICE_OFFLINE`
- no MQTT ack in time → `MQTT_ACK_TIMEOUT`
- task create 4xx → `TASK_CREATE_FAILED`
- invalid 3MF structure → `INVALID_3MF`
- two concurrent identical jobs in the time bucket → `IDEMPOTENCY_REPLAY`

### 3. Log and metrics alignment

Update existing structured logging and metrics (from Phase 8) so they include `error_code` where relevant and helpful.

Requirements:
- when logging `bambu.cloud.job.failed`, always include `error_code`
- when incrementing failure-related metrics, add `error_code` as a tag where practical
- do not change success logs, just enrich failure logs with normalized codes

### 4. Job and API surfaces

Update `BambuCloudJob`-related schemas and API responses (where appropriate) to optionally expose error codes in a safe way.

Requirements:
- expose `error_code` on job DTOs (e.g. in `BambuCloudJobOut`)
- do NOT expose internal technical messages unless they are already being shown and are safe
- use `to_user_message(error_code)` in API responses if there is a place where a user-friendly reason is currently missing or ad-hoc

Keep these fields optional and additive so existing clients do not break.

### 5. History result_reason mapping

Update the PrintHistory integration so `result_reason` values align with the taxonomy:
- e.g. `AUTH_REAUTH_REQUIRED`, `DEVICE_OFFLINE`, `MQTT_ACK_TIMEOUT`, `INVALID_3MF`, etc.

Requirements:
- when finalizing history for a job, if `error_code` is set and indicates failure, use a high-level reason string based on `to_user_message(error_code)`
- keep result/result_reason stable enough for reporting and UI

### 6. Tests

Add or extend tests to cover:
- mapping of internal failures to taxonomy codes
- retryability decisions via `is_retryable(error_code)` used in dispatch/worker
- presence of `error_code` in failure logs and metrics calls (via test logger/metrics double)
- job and history surfaces showing the correct `error_code` / `result_reason` for key scenarios (auth invalid, device offline, mqtt timeout, invalid 3mf, task create failure)

Follow existing patterns for unit/integration tests.

---

## Non-goals in this phase

Do NOT implement yet:
- external alerting/webhook integrations
- a full-blown incident management system
- changes to retry algorithms beyond aligning them with the taxonomy

---

## Deliverables

1. Central Bambu error taxonomy module.
2. Normalized error_code usage across Bambu Cloud auth/dispatch/worker/MQTT/history.
3. Enriched logs/metrics and API/job/history surfaces with safe error codes and messages.
4. Tests confirming the taxonomy is used consistently.

---

## Output format

When done, respond with:
1. Summary of the error taxonomy and how it is applied.
2. Exact files changed.
3. Example error_code mappings for major failure types.
4. Effects on logs, metrics, jobs, and history.
5. Any remaining edge cases not covered by the taxonomy.