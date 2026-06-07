# Claude Code Prompt — Phase 4: API Refactor for Job-Based Bambu Cloud Printing

Read these first:
- `docs/bambu_cloud_print_implementation_plan.md`
- the completed Phase 1 schema work
- the completed Phase 2 auth/token manager implementation
- the completed Phase 3 dispatch engine implementation

Your task is to implement **only Phase 4: API refactor**.
Do not implement worker execution, queue processing, MQTT correlation, or PrintHistory integration yet.

## Current state
Already implemented:
- Phase 1: `Organization` auth fields, `BambuCloudJob`, `PrintHistory` schema changes, migrations
- Phase 2: `bambu_auth.py` with canonical token lifecycle, per-org lock, legacy fallback, endpoint refactor in `api/orgs.py`
- Phase 3: `bambu_dispatch.py` with idempotent job creation, validation/preparation, retry-aware cloud dispatch helpers, and reusable low-level Bambu cloud HTTP wrappers in `bambu.py`

Current limitation:
- `dispatch_cloud_job(...)` is still synchronous and must NOT be called directly inside the main request thread in the final architecture
- `send_to_printer` still needs to be refactored to create a job-oriented flow instead of direct cloud dispatch

## Goals
1. Refactor the Bambu path in `send_to_printer` so the API becomes **job-based**.
2. Add job inspection endpoints for frontend/admin polling.
3. Return stable job-oriented payloads suitable for future worker integration.
4. Preserve LAN behavior and all non-Bambu printer paths.

## Constraints
- Preserve backward compatibility.
- Do not break existing Bambu LAN path.
- Do not implement the worker/queue engine yet.
- Do not implement MQTT/state machine logic yet.
- Do not add PrintHistory finalization logic yet.
- Do not redesign unrelated APIs.
- Never log secrets or raw bearer tokens.
- Prefer small safe changes.

## Core architecture requirement
At the API layer, Bambu cloud printing must now be represented as:
1. create/reuse a `BambuCloudJob`
2. prepare it if appropriate
3. return a **job response** instead of performing full synchronous cloud dispatch in the request/response cycle

This phase is about the API contract and request handling shape.
It is acceptable to leave the actual execution handoff as a stub/placeholder for Phase 5, as long as the API no longer performs the full cloud print flow inline for the new job-based path.

## Required implementation

### 1. Refactor `send_to_printer`
Update:
- `backend/app/api/files.py`

Requirements:
- Preserve existing behavior for non-Bambu printers.
- Preserve existing Bambu LAN path.
- For the Bambu cloud path:
  - stop directly calling the old synchronous cloud-print path from the request handler
  - create or reuse a `BambuCloudJob` via `bambu_dispatch.create_cloud_job(...)`
  - prepare the job if appropriate via `bambu_dispatch.prepare_cloud_job(...)`
  - return a `202 Accepted`-style response payload with at minimum:
    - `job_id`
    - `status`
    - `printer_id`
    - `dispatch_mode`
    - `idempotency_key`
    - a clear message like `queued` / `prepared` / `accepted`
- Do NOT call `dispatch_cloud_job(...)` inline from the API request unless an existing architectural constraint absolutely forces it, and if you must temporarily do so behind a feature-flagged fallback, keep the new job-based contract primary and clearly isolate the temporary behavior.

### 2. Add job endpoints
Create a new API module if cleaner, e.g.:
- `backend/app/api/bambu_jobs.py`

Or extend an existing API file if the project convention strongly prefers that.

Add endpoints for:
- `GET /bambu-jobs/{job_id}`
- `GET /bambu-jobs`
- `POST /bambu-jobs/{job_id}/retry`
- `POST /bambu-jobs/{job_id}/cancel`
- `GET /printers/{id}/active-job`
- `GET /orgs/me/bambu-health`

Scope notes:
- `GET /bambu-jobs/{job_id}` should return the canonical job state from `BambuCloudJob`
- `GET /bambu-jobs` should support basic filtering suitable for UI/admin use (at least org-scoped, optionally by printer/status)
- `POST /bambu-jobs/{job_id}/retry` can be a safe stub if Phase 5 is required before full execution; it should still validate job state and return a meaningful response contract
- `POST /bambu-jobs/{job_id}/cancel` can also be a stub/non-terminal API contract if true Bambu task cancellation belongs to a later phase, but the route and state validation should exist
- `GET /printers/{id}/active-job` should expose the current non-terminal job for that printer if present
- `GET /orgs/me/bambu-health` may be a minimal/stub version in this phase if the richer diagnostics are planned for Phase 8; still return a stable contract

### 3. Schemas / DTOs
Add or update Pydantic schemas for:
- `BambuCloudJobOut`
- `BambuCloudJobListOut`
- `BambuJobActionOut`
- `BambuHealthOut`
- any `send_to_printer` response model needed for the new job-based Bambu cloud path

Requirements:
- schemas must reflect the real `BambuCloudJob` fields relevant to frontend polling
- status values should come from the canonical enum
- responses should be explicit and stable, not ad-hoc dicts if the codebase already uses schemas

### 4. Auth / access control / scoping
Follow existing repo conventions for:
- org scoping
- current user access
- printer ownership checks
- admin vs normal user visibility

Requirements:
- users should only see jobs belonging to their org
- printer active-job lookup must be org-safe
- do not expose sensitive Bambu response payloads unless that already matches the app's admin/debug conventions

### 5. Backward compatibility
Requirements:
- Do not break any existing client that uses non-Bambu flows.
- Keep the legacy Bambu cloud dispatch code available behind internal service boundaries if still needed temporarily, but the API should now favor the job-based response model.
- LAN mode must remain untouched.

### 6. Minimal tests
Add tests for API behavior if practical in this phase.
At minimum, cover:
- Bambu cloud path returns a job-based response instead of immediate legacy send result
- non-Bambu path remains unchanged
- active-job endpoint returns the non-terminal job for a printer
- org scoping on job fetch/list endpoints

## Non-goals
Do NOT implement in this phase:
- actual queue consumer / worker execution loop
- MQTT correlation
- PrintHistory finalization
- full observability/metrics package
- final error taxonomy module unless strictly required for compilation

## Deliverables
1. Refactored Bambu cloud request flow in `send_to_printer`
2. New job API endpoints
3. New/updated schemas
4. Minimal tests for the new contract

## Output format
When done, respond with:
1. Summary of API contract changes
2. Exact files changed
3. Example request/response payloads
4. Backward compatibility notes
5. Risks / follow-ups for Phase 5
