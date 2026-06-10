# Claude Prompt — Unified Printer Interface (Cloud + LAN + Agent + Bambu)

Read the existing frontend and backend code first.
This task is to implement a **single unified printer operations interface** in the frontend, instead of separate UX flows per printer type.

## Product goal
Monofarm must have **one printer interface** for operators.
Users should not feel that Bambu Cloud, Bambu LAN/agent, Moonraker, or manual printers are separate products.
The UI should present one consistent operational model, while adapting under the hood to the printer backend.

Some printers will work through:
- Bambu Cloud V2 jobs
- Bambu LAN + local agent
- Moonraker / Klipper
- manual / other printers

The interface must unify these into one operator experience.

---

## Core principle
Do NOT build separate pages or disconnected widgets for each printer type.
Instead, build a **unified Printer Control / Printer Detail / Print Queue experience** with a shared UI contract.
Backend-specific differences should be abstracted behind adapters/selectors/mappers in the frontend.

---

## What to build

### 1. Create a unified frontend printer domain model
Inspect existing frontend types and create a unified UI-level model that maps backend-specific printer/job/history/health data into one shape.

Create a mapper/adaptor layer that converts backend responses into a shared frontend shape, for example:

- `UnifiedPrinter`
  - `id`
  - `name`
  - `kind`
  - `backend_type` (`bambu_cloud`, `bambu_lan`, `moonraker`, `manual`, `other`)
  - `status`
  - `is_online`
  - `active_job`
  - `supports_camera`
  - `supports_remote_start`
  - `supports_cancel`
  - `supports_retry`
  - `supports_live_progress`
  - `supports_health`
  - `health_summary`

- `UnifiedPrinterJob`
  - `id`
  - `printer_id`
  - `file_name`
  - `status`
  - `progress_pct`
  - `eta_minutes`
  - `started_at`
  - `completed_at`
  - `error_code`
  - `error_message`
  - `result_reason`
  - `source` (`cloud`, `lan`, `moonraker`, `manual`)
  - `dispatch_mode`
  - `can_retry`
  - `can_cancel`
  - `is_active`
  - `is_terminal`

- `UnifiedPrinterHealth`
  - `backend_type`
  - `connected`
  - `last_seen_at`
  - `reauth_required`
  - `warnings[]`
  - `details`

Use the backend-specific endpoints to fill this unified model.

---

### 2. Build one unified Printer Detail page
Replace fragmented printer-type UX with one unified printer detail page/panel.

This page must work for all printers.

The page should include these sections:

#### A. Header / summary
- printer name
- printer model / kind
- online/offline/attention badge
- backend badge (`Cloud`, `LAN`, `Moonraker`, `Manual`)
- quick actions (send print, retry active failure if relevant, cancel active job if allowed)

#### B. Current status card
One shared card that shows:
- current state
- active file/job name
- progress
- ETA
- last update time
- relevant error/warning if present

For Bambu Cloud, this should use `GET /api/printers/{id}/active-job` and Bambu job data.
For other printers, map the equivalent data into the same card UI.

#### C. Job timeline / activity
A shared “recent activity” section that shows recent jobs/prints for the printer.
For Bambu Cloud, this should consume the Bambu jobs/history data.
For Moonraker/manual/LAN printers, use existing history/job sources.
All should render in one consistent table/list style.

#### D. Health / diagnostics
A unified health section with backend-specific details rendered in one common layout.
For Bambu Cloud, use `bambu-health` and active-job signals.
For LAN/agent printers, use agent connectivity / IP / availability info if available.
For Moonraker, use its connection/state info.
Keep visual structure consistent even if details differ.

#### E. Camera panel
If the printer supports camera, show one consistent camera panel UI.
Under the hood, the source may differ:
- Bambu LAN via agent
- local IP camera stream
- Moonraker webcam
- other sources
But the UI should always look like one camera experience.

---

### 3. Build a unified “Send to printer” flow
The send flow must feel identical for operators across printer types.

Requirements:
- same modal/drawer/screen for selecting printer and confirming send
- after send, users should always get a consistent result UX:
  - queued / started / failed
  - link to active job / printer detail
- backend-specific dispatch details must stay hidden unless useful in diagnostics
- if the printer is Bambu Cloud, use the Bambu queued-result flow
- if LAN/agent or Moonraker printers behave differently, normalize the user-facing messaging into the same style

Do not create separate send UIs for Bambu vs non-Bambu.

---

### 4. Build a unified jobs/queue experience
Implement a common jobs/queue view for operators.

Requirements:
- one jobs page/table for all printer backends
- allow filtering by printer, status, backend type, source
- visually normalize statuses while preserving real backend state underneath
- map backend-specific raw states into a shared display vocabulary where helpful
  - e.g. queued / preparing / sending / acknowledged / printing / paused / completed / failed / cancelled / lost
- each row links to either:
  - unified job detail, or
  - unified printer detail with job focus

For Bambu Cloud, include all Bambu job fields.
For other backends, adapt as much as possible into the same table structure.

---

### 5. Add a unified job detail experience
Users should be able to inspect one job in a consistent UI, regardless of backend.

Requirements:
- build a shared job detail component/page
- backend-specific fields should appear in an “advanced details” section only when relevant
- common area should always show:
  - printer
  - file
  - status
  - progress
  - ETA
  - timestamps
  - result reason / safe error message
  - retry/cancel controls if available
- for Bambu Cloud, also show timeline states and cloud identifiers in diagnostics section
- for LAN/manual/Moonraker jobs, map existing data into the same common structure as much as possible

---

### 6. Unify health/diagnostics into one interface
Do not make Bambu health a totally separate admin island.

Requirements:
- create a shared diagnostics view/panel pattern
- within that pattern, show backend-specific subsections
- operator-facing summary should be simple and consistent:
  - connected / degraded / offline / needs reauth / no recent telemetry
- admin-expanded view can show backend-specific raw details
- Bambu Cloud details should use `/api/orgs/me/bambu-health`
- Bambu active-job and recent-job signals should also feed printer-level health
- do not make operators switch between radically different mental models per backend

---

### 7. Normalize actions and permissions
Users should see consistent actions across printers where possible.

Common actions:
- send print
- open active job
- cancel active job
- retry failed job
- open history
- open diagnostics

Rules:
- show only actions that make sense for that backend/printer/job state
- but keep placement and button styles identical across printer types
- respect existing RBAC/roles from the backend/frontend permission model

---

### 8. Camera integration in one UI
Because some printers have IP/agent camera capability, unify camera display.

Requirements:
- detect whether a printer supports camera from available fields / backend type / agent integration
- build one camera card/component used everywhere
- support loading/error/disabled states consistently
- if stream URLs or agent endpoints already exist, reuse them
- if camera support exists only partially, still render a consistent placeholder state like:
  - “Camera available through local agent”
  - “Camera unavailable”
  - “Remote camera not configured”

Do not create one camera UX for Bambu and a totally different one for Moonraker.

---

### 9. Frontend architecture requirements
- Reuse the project’s existing routing, API hooks, data fetching, table, badge, drawer, modal, and permission systems.
- Do not create duplicated printer-specific pages unless unavoidable.
- Prefer shared components plus backend adapters over duplicated JSX.
- Put backend mapping logic in dedicated selector/adapter utilities, not inline in components.

---

### 10. Querying and refresh behavior
Implement consistent polling/refresh behavior for the unified UI.

Requirements:
- printer detail should refresh active state appropriately
- active jobs should poll more frequently than terminal jobs
- history can refresh less often
- Bambu active-job and jobs list must invalidate on send/retry/cancel
- other printer backends should plug into the same refresh pattern where possible

---

### 11. Empty, degraded, and mixed-backend states
Handle these well:
- no active job
- printer offline
- no telemetry
- no camera
- reauth required
- LAN agent disconnected
- Bambu cloud disabled
- mixed fleet with different capabilities

The UI must remain consistent and understandable.
Do not expose backend chaos directly to the operator.

---

### 12. Testing
Add frontend tests consistent with the existing stack.

At minimum cover:
- unified printer detail rendering for:
  - bambu cloud printer
  - bambu lan/agent printer
  - moonraker printer
- unified status card with different backend payloads
- action visibility based on backend type and permissions
- camera panel states
- diagnostics panel states
- jobs table rendering mixed backend jobs consistently

---

## Deliverables
When done, respond with:
1. Summary of the unified interface architecture
2. Exact frontend files changed
3. Which backend endpoints/data sources are mapped into the unified UI
4. What printer backends are now supported in the same interface
5. Remaining gaps or follow-up ideas
