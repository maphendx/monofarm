# Codex / Claude Code Prompt — Phase 7: PrintHistory Integration for Bambu Cloud Jobs

Read these first:
- `docs/bambu_cloud_print_implementation_plan.md`
- the implemented Phases 1–6 (schema, auth, dispatch, API refactor, worker/queue, MQTT + state machine)

Assume that:
- `BambuCloudJob` is the canonical lifecycle record for Bambu cloud prints.
- `bambu_job_state.py` enforces valid status transitions and marks jobs lost.
- `bambu.py` now correlates MQTT reports into job status, progress, eta, and error_msg.
- `PrintHistory` already has the Bambu-related columns added in Phase 1.
- APIs and workers are wired so jobs move through `queued → ... → task_created → acknowledged → printing → completed/failed/cancelled/lost`.

Your task: **implement only Phase 7: PrintHistory integration**.
Do NOT change the worker/scheduler architecture, MQTT correlation logic, or API contract shape beyond what is strictly needed to expose history.

---

## Goals

1. Ensure every Bambu cloud print results in a consistent `PrintHistory` record.
2. Link `PrintHistory` and `BambuCloudJob` via `bambu_cloud_job_id`.
3. Persist meaningful result metadata (status, duration, file, task/project ids, source) without duplicates.
4. Preserve existing semantics for non-Bambu and LAN/Moonraker prints.

---

## Constraints

- Preserve backward compatibility.
- Do NOT break existing non-Bambu and LAN/Moonraker history behavior.
- Do NOT change the job state machine definition.
- Do NOT implement observability/metrics/error-taxonomy refactors in this phase.
- Do NOT change API request behavior for send_to_printer (it must stay job-based).
- Avoid duplicate history entries for the same cloud job.

---

## Required implementation

### 1. Link PrintHistory to BambuCloudJob

Use the existing schema fields added in Phase 1:
- `PrintHistory.bambu_cloud_job_id`
- `PrintHistory.bambu_task_id`
- `PrintHistory.bambu_project_id`
- `PrintHistory.file_sha256`
- `PrintHistory.source`
- `PrintHistory.result_reason`

Implement a small service/helper, e.g. in a new or existing module:
- `backend/app/services/print_history_bambu.py` (or similar)

Responsibilities:
- given a `BambuCloudJob` and associated printer/file/org/user context, create or update a matching `PrintHistory` row
- ensure one history row per job (idempotent with respect to job identity)
- set `source = 'cloud'` for Bambu cloud jobs

### 2. Lifecycle hooks from job state transitions

Decide and implement where in the lifecycle `PrintHistory` should be created/updated.

Reasonable approach:
- create or upsert history when a job first transitions to `printing` (start of actual print)
- finalize history on terminal transitions:
  - `completed`
  - `failed`
  - `cancelled`
  - `lost`

Implementation options (pick the one best matching existing architecture):
- hook into `bambu_job_state.transition_job(...)` so transitions to `printing`/terminal states call the history helper
- or add a distinct small service that listens to/job state changes in worker/MQTT and calls history updates

Requirements:
- do not duplicate history entries for a single job
- be idempotent: if the same transition is processed twice, history should remain consistent, not doubled

### 3. Populate meaningful PrintHistory fields

Populate at least:
- `bambu_cloud_job_id`
- `bambu_task_id` and `bambu_project_id` if present on the job
- `printer_id`
- `organization_id`
- `created_by_user_id` (from job if available)
- `file_name`
- `file_sha256`
- `source = 'cloud'`
- `result`/`result_reason` based on final job status:
  - `completed` → success
  - `failed` → include job.error_msg or a mapped technical reason
  - `cancelled` → user/system cancelled
  - `lost` → timeout / lost contact
- `started_at` and `finished_at` (or equivalent) based on job timestamps:
  - `started_at` ~= `started_printing_at` if available, otherwise `created_at`
  - `finished_at` from `completed_at`/`failed_at`/`cancelled_at`/`lost` decision
- compute `duration` if the model supports it, or at least store enough timestamps so it can be derived later

Keep the mapping logic centralized in the history helper for clarity.

### 4. Respect non-Bambu / LAN / Moonraker flows

Requirements:
- keep existing non-Bambu and LAN/Moonraker history code paths intact
- avoid changing how their `PrintHistory` rows are created unless necessary for internal consistency
- if shared helper code is created, branch on `source` or printer type so behavior is explicit

### 5. API exposure (if needed)

If the frontend already consumes print history endpoints and they need new Bambu-specific fields, update the relevant DTOs/schemas minimally:
- include `bambu_cloud_job_id`, `bambu_task_id`, `bambu_project_id`, `source`, and Bambu-specific result_reason where appropriate

Keep contracts backward compatible:
- existing clients should not break
- new fields may be optional or added in response payloads where safe

### 6. Tests

Add tests at unit and/or integration level to cover:
- a BambuCloudJob that reaches `printing` then `completed` results in a single, correct PrintHistory row
- a job that fails, is marked retryable, and later is retried successfully:
  - yields a separate job and history record, or a clearly defined, documented behavior
- jobs that end in `failed`, `cancelled`, or `lost` produce an appropriate `result` and `result_reason`
- non-Bambu / LAN / Moonraker histories are not broken by the new code

Follow existing patterns for where history tests live.

---

## Non-goals in this phase

Do NOT implement yet:
- the full observability / metrics / diagnostics package (Phase 8)
- a complete Bambu error taxonomy refactor (Phase 9)
- any changes to auth or dispatch behavior
- cross-service reporting or external webhooks

---

## Deliverables

1. History helper/service that links BambuCloudJob to PrintHistory.
2. Lifecycle hooks from job state transitions to history updates.
3. Correct, deduplicated PrintHistory rows for Bambu cloud prints.
4. Tests validating the new behavior and non-regression for existing flows.

---

## Output format

When done, respond with:
1. Summary of how PrintHistory is now integrated with BambuCloudJob.
2. Exact files changed.
3. How duplicate histories are avoided.
4. Mapping rules from job status to history result/result_reason.
5. Risks / follow-ups for Phase 8.
