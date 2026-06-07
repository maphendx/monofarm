# Claude Prompt — Full Frontend Implementation for Bambu Cloud V2

Read all existing backend code and existing frontend code first.
This task is to implement the **full frontend support** for the already completed Bambu Cloud V2 backend.
Do not redesign backend behavior. The backend pipeline is already complete and must be consumed correctly.

## Context
The backend already supports a full Bambu Cloud V2 flow:
- Bambu account connect / verify
- job-based cloud print send flow
- Bambu job list / detail / retry / cancel
- printer active job
- Bambu health diagnostics
- MQTT-driven live progress / ETA / status transitions
- PrintHistory integration
- normalized error codes / safe error messages
- feature flag `BAMBU_CLOUD_V2_ENABLED`
- rate limits / RBAC already enforced server-side

Your task is to make **all of this fully visible and usable in the frontend**.

---

## High-level goal
Implement the complete frontend experience for Bambu Cloud printing so that a user/admin/operator can:
1. connect Bambu
2. send a print to a Bambu printer
3. see queued/active/completed/failed jobs
4. open job details
5. see live progress / ETA / status
6. retry or cancel jobs when allowed
7. inspect Bambu health / diagnostics
8. see Bambu cloud print history in the normal history UI

---

## Requirements

### 1. Discover existing frontend architecture first
Before coding:
- inspect the frontend app structure
- identify routing, API client patterns, query/cache library, state management, table components, modal/drawer patterns, permission checks, settings pages, printer detail pages, and history pages
- reuse the project’s existing frontend conventions
- do NOT invent a parallel architecture

### 2. Implement every relevant backend endpoint in the frontend API layer
Find the frontend API client/services/hooks and add typed support for all Bambu Cloud V2 endpoints and DTOs.

At minimum support these endpoints:

#### Org/Bambu auth & diagnostics
- `POST /api/orgs/me/bambu-send-code`
- `POST /api/orgs/me/bambu-verify-code`
- `GET /api/orgs/me/bambu-health`

#### Job APIs
- `GET /api/bambu-jobs`
- `GET /api/bambu-jobs/{job_id}`
- `POST /api/bambu-jobs/{job_id}/retry`
- `POST /api/bambu-jobs/{job_id}/cancel`
- `GET /api/printers/{id}/active-job`

#### Print send flow
- existing send-to-printer endpoint for Bambu cloud path (already returns queued job result)

#### History
- existing history endpoint(s) that now include Bambu-related fields

Add full TypeScript types/interfaces for all relevant DTOs, including nested health payloads and job helper fields:
- `printer_name`
- `printer_model`
- `is_terminal`
- `is_active`
- `can_retry`
- `error_message`
- `progress_pct`
- `eta_minutes`
- `error_code`
- `result_reason`
- `dispatch_mode`
- `bambu_cloud_job_id`
- `bambu_task_id`
- `bambu_project_id`

### 3. Bambu settings / connect flow UI
Implement the full Bambu connect flow in the frontend.

Requirements:
- Add/upgrade a Bambu section in org settings / integrations / printer settings (wherever it best fits the existing app structure).
- Admin-only visibility for connect/verify/health actions.
- UI must support:
  - entering Bambu email
  - triggering send-code
  - entering verification code
  - verify/connect success state
  - showing reauth_required state
  - showing health summary from `/api/orgs/me/bambu-health`
- Handle rate-limit errors gracefully.
- Show safe error messages only.
- If `BAMBU_CLOUD_V2_ENABLED` is effectively disabled server-side (503 on cloud send path), show a clear disabled/unavailable message in the UI.

### 4. Bambu print send UX
Update the existing print/send flow so Bambu cloud printers use the new job-based behavior.

Requirements:
- When sending to a Bambu cloud printer, handle the queued response instead of waiting for a final print result.
- After a successful send, show a success notification like:
  - “Print queued”
  - include printer name/model if available
- Immediately navigate or link the user to the created job detail or active job view.
- Respect `dispatch_mode="cloud"`.
- Preserve current Moonraker / non-Bambu UX.

### 5. Jobs list UI
Implement a full Bambu jobs list view.

Requirements:
- Show a table/list of Bambu jobs using `GET /api/bambu-jobs`
- Include columns/cards for:
  - job id
  - printer name
  - printer model
  - file name
  - status
  - progress
  - ETA
  - created time
  - last updated / last MQTT time
  - error message / result reason when relevant
- Add filters if consistent with app conventions:
  - active vs terminal
  - status
  - printer
- Use visual badges/chips for statuses:
  - queued
  - validating
  - creating_project
  - uploading
  - task_created
  - acknowledged
  - printing
  - paused
  - completed
  - failed
  - cancelled
  - lost

### 6. Job detail UI
Implement a Bambu job detail page / drawer / modal using `GET /api/bambu-jobs/{job_id}`.

Requirements:
- Show all useful information for an operator/admin:
  - printer name / model
  - file name
  - status
  - progress
  - ETA
  - error code
  - safe error message
  - created_at, uploaded_at, task_created_at, printer_ack_at, started_printing_at, completed_at, last_mqtt_at
  - bambu_task_id / bambu_project_id when useful for diagnostics
- Add a clear status timeline UI based on available timestamps.
- If the backend exposes `is_terminal`, `is_active`, `can_retry`, use them directly for UI logic.
- Display retry/cancel buttons only when allowed.

### 7. Retry / cancel UX
Implement frontend actions for:
- retry job
- cancel job

Requirements:
- Only show buttons when the backend indicates they should be usable.
- After retry/cancel, invalidate/refetch all relevant queries.
- Show clear success/error toasts.
- Handle invalid retry/cancel states gracefully.
- Handle rate limit responses gracefully.

### 8. Live progress / polling strategy
Implement frontend polling so job status and progress feel live.

Requirements:
- Poll active job(s) and active-job endpoint for the selected printer.
- Use the project’s existing query library conventions (React Query / SWR / etc.).
- Poll more frequently for active jobs, less frequently for terminal jobs.
- Stop aggressive polling when jobs are terminal.
- If the printer details page exists, surface `GET /api/printers/{id}/active-job` there.
- If there is already WebSocket/SSE infra in the app, reuse it only if truly consistent with the current stack; otherwise use polling.

### 9. Printer detail integration
Integrate Bambu Cloud job visibility into the printer detail page/card.

Requirements:
- For Bambu printers, show current active job panel if one exists.
- Show status, progress, ETA, last updated, quick link to job detail.
- Show Bambu-specific distinction (Cloud vs LAN) where helpful.
- Do not clutter non-Bambu printer views.

### 10. History integration in frontend
Update the existing print history UI so Bambu cloud jobs are properly visible.

Requirements:
- Use Bambu-enhanced history fields where available:
  - `source`
  - `result_reason`
  - `bambu_cloud_job_id`
  - `bambu_task_id`
  - `bambu_project_id`
- Show source badge (`cloud`, `lan`, `moonraker`, etc.) if consistent with current UI.
- If `bambu_cloud_job_id` exists, allow navigation from history row to Bambu job detail.
- Show normalized result/error information in a user-friendly way.

### 11. Bambu health / diagnostics UI
Implement a health/diagnostics panel for admins.

Requirements:
- Use `GET /api/orgs/me/bambu-health`
- Show grouped cards/sections for:
  - Auth
  - MQTT
  - Printers
  - Jobs
- At minimum display:
  - auth configured
  - reauth required
  - auth type
  - mqtt connected
  - last_message_at
  - tracked devices
  - total/bambu_cloud/online/offline printers
  - active/stuck_or_lost/recent_failures/queued jobs
- Make this panel easy to scan.
- Keep it admin-only.

### 12. Permissions / roles
Respect frontend role/permission rules.

Requirements:
- Admin-only for connect/verify/health.
- Admin/operator/manager access for job list/get/retry/cancel if that matches existing permission model.
- Non-authorized users should not see controls they can’t use.

### 13. Error and empty states
Handle all important states cleanly:
- no Bambu configured
- reauth required
- no jobs yet
- active job exists
- failed job with retry available
- rate limited
- cloud feature disabled
- printer offline / lost
- invalid retry/cancel

Use safe backend `error_message` / `result_reason` / `error_code` fields where useful.
Do not expose raw technical payloads.

### 14. Query invalidation / cache updates
Make sure all relevant views stay consistent.

After send/retry/cancel/connect/verify:
- invalidate jobs list
- invalidate job detail
- invalidate printer active-job
- invalidate history if needed
- invalidate Bambu health when relevant

### 15. Testing
Add frontend tests consistent with the project’s stack.

At minimum test:
- Bambu connect flow render + verify success/error
- jobs list renders active/terminal jobs correctly
- job detail renders progress/error/timeline
- retry/cancel buttons obey `can_retry` / status
- health panel renders nested payload
- feature-disabled / no-config / reauth-required states

Prefer the project’s existing test style (component tests, integration tests, or E2E if already present).

---

## Non-goals
- Do not redesign the entire frontend.
- Do not introduce a new global state architecture.
- Do not add websockets unless the app already uses them and it is straightforward.
- Do not change backend contracts unless absolutely necessary and clearly justified.

---

## Deliverables
When done, respond with:
1. Summary of frontend pages/components/hooks added or updated
2. Exact frontend files changed
3. Which backend endpoints are now fully consumed in the frontend
4. What user flows are now supported end-to-end
5. Any remaining gaps or recommended follow-up polish
