# Codex / Claude Code Prompt — Phase 6: MQTT Correlation and Job State Machine

Read these first:
- `docs/bambu_cloud_print_implementation_plan.md`
- the implemented Phases 1–5 (schema, auth, dispatch, API refactor, worker/queue)

Assume that:
- `BambuCloudJob` is the canonical cloud job model.
- `bambu_auth.py` manages access tokens and legacy fallback.
- `bambu_dispatch.py` creates/prepares/dispatches jobs and persists dispatch-stage state like `task_created`.
- API endpoints already expose job list/get/retry/cancel/active-job/health.
- An APScheduler-backed worker now polls and executes queued jobs off the request thread.

Your task: **implement only Phase 6: MQTT correlation and job state machine**.
Do NOT implement PrintHistory finalization, full observability package, or the complete error taxonomy in this phase.

---

## Goals

1. Correlate live Bambu MQTT printer reports with active `BambuCloudJob` records.
2. Introduce a strict job state machine so transitions are valid and explicit.
3. Detect lost/stuck jobs when task creation succeeds but printer telemetry never progresses.
4. Preserve existing printer-state caching behavior used elsewhere in the app.

---

## Constraints

- Preserve backward compatibility.
- Do NOT break Bambu LAN path.
- Do NOT modify non-Bambu flows.
- Do NOT move PrintHistory logic into this phase.
- Do NOT redesign the scheduler/worker architecture from Phase 5.
- Keep secrets out of logs.
- Prefer small, safe changes with clear transition rules.

---

## Required implementation

### 1. Add a dedicated state machine module

Create a new file:
- `backend/app/services/bambu_job_state.py`

Implement:
- canonical allowed transitions for `BambuCloudJob.status`
- helper(s) such as:
  - `can_transition(from_status, to_status) -> bool`
  - `transition_job(job, to_status, reason=None, ...)`
  - or another clean API that enforces valid transitions centrally

Requirements:
- prevent illegal jumps (for example completed -> printing, failed -> task_created, cancelled -> acknowledged)
- allow legitimate forward progress through:
  - `queued` / `validating`
  - `creating_project`
  - `uploading`
  - `task_creating`
  - `task_created`
  - `acknowledged`
  - `printing`
  - `paused`
  - terminal states: `completed`, `failed`, `cancelled`, `lost`
- keep the implementation explicit and easy to audit

### 2. Extend MQTT handling in bambu.py

Update:
- `backend/app/services/bambu.py`

Find the existing MQTT report/message handling (such as `_on_message`) and extend it so incoming device reports can update the active `BambuCloudJob`.

Requirements:
- Preserve the current printer-state cache behavior for the rest of the app.
- When an MQTT report arrives for a Bambu device, find the matching active/non-terminal `BambuCloudJob` using the best available correlation strategy.
- Use available signals such as:
  - `dev_id`
  - task id if present
  - filename / subtask name / project info if available
  - printer current state
  - timing window and active-job context
- Update job state via the new state-machine helper, not by direct ad-hoc writes.
- Update useful runtime fields on the job where available:
  - `last_mqtt_at`
  - progress percentage
  - ETA if available
  - printer ack timestamp
  - started_printing_at
  - completed_at / failed_at
  - status_reason or error summary if printer reports a failure

### 3. Correlation strategy

Implement a pragmatic, explicit matching strategy.
Priority should be something like:
1. exact task-id match if the MQTT payload contains it and `bambu_task_id` is known
2. exact `printer_bambu_dev_id` + active non-terminal job for that printer
3. filename/subtask correlation within a safe recent time window

Requirements:
- if correlation is ambiguous, do not randomly update the wrong job
- prefer no match over incorrect match
- log enough context to debug mismatches, but without secrets

### 4. Stuck / lost job detection

Add logic so jobs can be marked `lost` or otherwise surfaced as stuck when dispatch got to `task_created` but printer-side progress never materializes.

It is acceptable in this phase to implement this as a lightweight scheduler/worker check rather than a complex distributed watchdog.

Requirements:
- define timeout conditions for at least:
  - task created but no printer acknowledgement within a reasonable window
  - acknowledged/printing but no MQTT updates for too long
- mark such jobs `lost` using the state machine
- store a useful `status_reason`
- do not misclassify completed or terminal jobs

### 5. API compatibility

If needed, update job DTOs/schemas so the UI can see new job fields exposed by MQTT-driven updates (for example progress, last_mqtt_at, printer ack timestamps).
Keep the Phase 4 contract stable and extend it safely.

### 6. Tests

Add tests for:
- valid and invalid state transitions in `bambu_job_state.py`
- MQTT report causes the correct job transition for a matched active job
- ambiguous/no-match report does not incorrectly update another job
- lost/stuck detection marks jobs appropriately

Use the repo’s existing test style (unit where possible, integration only if needed).

---

## Non-goals in this phase

Do NOT implement yet:
- PrintHistory creation/updating
- the full observability/metrics/diagnostics package
- a complete global error taxonomy refactor
- cross-process distributed locks

---

## Deliverables

1. New `bambu_job_state.py` module with explicit transition rules.
2. MQTT-driven correlation from printer reports to `BambuCloudJob`.
3. Stuck/lost job detection.
4. Tests covering transitions and correlation basics.

---

## Output format

When done, respond with:
1. Summary of MQTT correlation/state-machine architecture.
2. Exact files changed.
3. Correlation strategy implemented.
4. Lost/stuck detection rules.
5. Risks / follow-ups for Phase 7.
