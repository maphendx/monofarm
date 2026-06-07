# Claude Code Prompt — Phase 2: Auth / Token Manager

Read `docs/bambu_cloud_print_implementation_plan.md` first and also review the already completed Phase 1 schema changes.

## Context
Phase 1 is already implemented:
- `Organization` now has `bambu_access_token`, `bambu_access_token_expires_at`, `bambu_auth_type`, `bambu_user_id`, `bambu_last_auth_success_at`, `bambu_last_auth_error`, `bambu_reauth_required`
- legacy `bambu_refresh_token` still exists and remains overloaded for backward compatibility
- `BambuCloudJob` and `PrintHistory` schema changes are already in place

Your task is to implement **only Phase 2: Auth / token manager**.
Do not implement dispatch engine, worker execution, or API job queue flow yet.

## Goals
1. Introduce a dedicated `bambu_auth` service.
2. Stop conflating access token and refresh token in new code.
3. Add safe token lifecycle management with per-org locking.
4. Refactor Bambu connect/verify endpoints to use the new auth service.
5. Preserve backward compatibility with legacy organizations and existing LAN/cloud flows.

## Constraints
- Preserve backward compatibility.
- Do not break existing Bambu LAN path.
- Do not change print dispatch behavior yet.
- Do not remove working code unless it is safely replaced.
- Prefer small, safe, explicit changes.
- Never log raw tokens, access codes, emails, or passwords.
- Redact secrets in logs and exception messages.
- If schema assumptions are needed, use the fields added in Phase 1 exactly as they exist.

## Required implementation

### 1. Create dedicated auth service
Create a new file:
- `backend/app/services/bambu_auth.py`

Implement at minimum:
- `get_valid_access_token(org_id: int) -> str`
- `refresh_access_token(org_id: int) -> str`
- `login_with_password(org_id: int) -> str`
- `login_with_email_code(email: str, code: str, region: str) -> AuthResult`
- `mark_reauth_required(org_id: int, reason: str) -> None`
- `store_auth_result(...) -> None`

If a small dataclass or typed result object is useful, create one, e.g. `AuthResult`.

### 2. Locking
Add a per-organization lock so concurrent requests cannot trigger a refresh/login storm.
This can be an in-memory lock if that matches current architecture, but the code should be clearly structured so it can be replaced by a distributed lock later.

### 3. Backward compatibility strategy
Implement fallback behavior for orgs that still rely on legacy token storage patterns:
- `bambu_auth_type` may be `NULL`
- legacy `bambu_refresh_token` may still actually contain an access token from the old flow
- existing encrypted email/password fields still matter

Rules:
- New code should treat `bambu_access_token` as the canonical access token field.
- `bambu_refresh_token` must remain readable for compatibility.
- If a legacy org has no `bambu_access_token` but has a usable legacy token, allow fallback.
- On successful new auth, populate the new fields cleanly.

### 4. Encryption / secret handling
Match the existing repository pattern where encryption/decryption happens in the service layer, not via a custom DB column type.
Review current logic in `bambu.py` (and any related helpers) and reuse or extract the existing Fernet-based behavior rather than inventing a second encryption scheme.

Requirements:
- encrypt on write
- decrypt on read
- avoid duplicate crypto logic if it can be sensibly shared
- never log decrypted values

### 5. Refactor org API endpoints
Update:
- `backend/app/api/orgs.py`

Specifically refactor the Bambu auth endpoints such as:
- `/me/bambu-send-code`
- `/me/bambu-verify-code`

Requirements:
- route logic should call `bambu_auth.py` instead of embedding auth lifecycle directly
- after successful verify/login, store the proper auth state in the new fields
- do not confuse access token and refresh token
- preserve current external behavior as much as possible
- keep the existing Bambu init/re-init behavior working, but invoke it through a cleaner service boundary where practical

### 6. Integration with existing Bambu service
Review `backend/app/services/bambu.py` and refactor only what is necessary so it can consume the new auth manager cleanly.
Do not redesign the whole service yet.

Requirements:
- existing LAN/device behavior must keep working
- existing cloud flows should keep working
- token access should go through the new auth service where practical
- add clear TODO boundaries only where truly necessary

### 7. Reauth handling
Implement consistent behavior for expired/invalid auth:
- `mark_reauth_required(org_id, reason)` should set the proper fields on `Organization`
- update `bambu_last_auth_error`
- set `bambu_reauth_required = true`
- preserve enough context for future diagnostics without storing sensitive payloads

### 8. Tests
Add tests for the new auth logic if practical in this phase.
Prefer at least:
- unit tests for token fallback behavior
- unit tests for auth result storage
- tests for reauth-required marking
- tests proving legacy orgs still work

If the project already has a test pattern for service tests, follow it.

## Non-goals
Do NOT implement in this phase:
- dispatch engine
- job creation flow
- queue/worker
- cloud job state machine
- MQTT correlation
- print history integration
- observability/metrics beyond what is minimally needed for safe auth logging

## Deliverables
1. New `bambu_auth.py` service.
2. Updated Bambu auth endpoints in `api/orgs.py`.
3. Minimal necessary refactor in `bambu.py` to use the auth manager safely.
4. Backward-compatible handling of legacy org auth state.
5. Tests for core auth lifecycle behavior.

## Output format
When done, respond with:
1. Summary of auth architecture changes
2. Exact files changed
3. Backward compatibility strategy implemented
4. Tests added
5. Risks / follow-ups for Phase 3
