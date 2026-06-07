# Codex / Claude Code Prompt — Phase 5: Worker / Queue Execution for Bambu Cloud Jobs

Read these first:
- `docs/bambu_cloud_print_implementation_plan.md`
- the implemented Phases 1–4 (schema, auth, dispatch, API refactor)

Assume that:
- `BambuCloudJob` model and migrations are in place.
- `bambu_auth.py` manages tokens and legacy fallback.
- `bambu_dispatch.py` has `dispatch_cloud_job(job_id)` and related helpers.
- `send_to_printer` now creates/queues a `BambuCloudJob` and returns 202.
- `bambu_jobs` API endpoints exist for get/list/retry/cancel/active-job/health.

Your task: **implement only Phase 5: worker/queue execution**.
Do NOT implement MQTT correlation, PrintHistory finalization, or observability in this phase.

---

## Goals

1. Add a worker/queue path that executes `BambuCloudJob` instances created by the API.
2. Move the actual cloud dispatch work out of the request thread and into a background worker.
3. Ensure safe concurrency (per-printer locking, basic org-level throttling where reasonable).
4. Lay the foundation for retries and dead-letter handling (Phase 9/10 will refine errors, Phase 8 observability).

---

## Constraints

- Preserve backward compatibility.
- Do NOT break Bambu LAN path.
- Do NOT modify existing non-Bambu flows.
- Do NOT change the job-based API contract introduced in Phase 4.
- Do NOT implement MQTT/status correlation yet.
- Do NOT implement PrintHistory writes or finalization yet.
- Do NOT add complex metrics or error-taxonomy wiring yet.
- Never log secrets (tokens, passwords, codes).

---

## Required implementation

### 1. Worker entrypoint and queue integration

Create a worker module (if none yet for Bambu), e.g.:
- `backend/app/workers/bambu_jobs.py`

Implement:
- a function that picks up `BambuCloudJob` records in `queued` or `validating` state and processes them to completion (or terminal failure) by calling `bambu_dispatch.dispatch_cloud_job(job_id)`.
- use the existing queue/worker infrastructure that the project already uses (Redis queue, APScheduler, or similar). Follow current patterns from other workers in this repo.

Key points:
- API should **not** call `dispatch_cloud_job` directly anymore – it only creates/prepares jobs.
- Worker is responsible for running the heavy Bambu cloud HTTP flow.
- If the project has `INLINE_WORKERS` / dev mode, respect it (e.g. run synchronously only in that mode if already standard in the project).

### 2. Job polling / selection strategy

Implement a clear strategy to pick which jobs to run:
- Typically: query for `status in ('queued', 'validating', 'creating_project', 'uploading', 'task_creating')` and `retry_count` within limits.
- Use an org-scoped or global batch size to avoid overloading.
- Optionally support a single-job execution entrypoint such as `run_bambu_cloud_job(job_id)` so `POST /bambu-jobs/{id}/retry` can schedule specific jobs.

In this phase it is acceptable to keep the polling/simple scheduling logic minimal as long as:
- it is deterministic;
- it obeys basic concurrency rules (per-printer locking);
- it does not starve other tenants/orgs.

### 3. Concurrency and locking

Implement per-printer concurrency control:
- two jobs should **not** dispatch to the same physical Bambu printer concurrently.
- a simple in-process lock map keyed by `printer_id` is sufficient for now, following the same pattern as per-org lock in `bambu_auth`.
- add clear TODO or abstraction for future Redis-based cross-process locking if needed.

Optional but recommended:
- org-level concurrency cap (e.g. max N concurrent jobs per org) to avoid one org hammering the Bambu API.

### 4. Retry scheduling foundation

Do not implement full retry strategy yet, but:
- ensure `BambuCloudJob.retry_count` is incremented when a dispatch attempt fails in a retryable way (you can read `error_details_json.retryable` if Phase 3 already writes that, or for now infer from the caught exception type).
- ensure terminal failures set `status = failed` and do **not** get re-picked automatically.
- ensure non-terminal, retryable failures can be safely retried manually later via `POST /bambu-jobs/{id}/retry`.

Retain minimal information about the last failure:
- error_code
- error_details_json (do not include raw secrets)

### 5. Integrate with existing APIs

Update the job API where necessary so that:
- `POST /bambu-jobs/{job_id}/retry` can enqueue or mark the job so the worker picks it up again.
- The retry endpoint should:
  - validate current job status (only certain states are retryable, e.g. `failed` with retryable flag; avoid retrying `completed`/`cancelled`).
  - bump retry_count and set status/state appropriately (`queued`/`validating`), without executing the dispatch inline.

Keep the contract added in Phase 4 stable; only extend the behavior to hook into the worker.

### 6. Tests

Add tests for the new worker execution path and minimal retry behavior.
At minimum:
- a happy-path test where a queued job moves to `task_created` or `completed` when the worker runs (you can stub/mocking bambu_dispatch.dispatch_cloud_job to focus on the worker logic).
- a test ensuring two jobs for the same printer are not executed concurrently in the same process (you can approximate this with a lock assertion or controlled blocking stub).
- a test that `POST /bambu-jobs/{id}/retry` changes job state as expected and does not run dispatch inline.

Follow the existing test patterns (integration vs unit) already present in the repo for workers and APIs.

---

## Non-goals in this phase

Do NOT implement yet:
- MQTT-based status updates or job state transitions based on device events.
- PrintHistory creation/updating.
- health/diagnostics internals beyond what already exists as stubs from Phase 4.
- full error taxonomy across the whole app.
- heavy metrics/logging work (only minimal logging needed for debugging).

---

## Deliverables

1. New worker/queue code to execute Bambu cloud jobs.
2. Wiring from job API retry endpoint to queue/worker.
3. Per-printer concurrency controls.
4. Minimal tests proving the basics work.

---

## Output format

When done, respond with:
1. Summary of worker/queue architecture changes.
2. Exact files changed.
3. Concurrency/locking strategy implemented.
4. Retry behavior supported.
5. Risks / follow-ups for Phase 6.
