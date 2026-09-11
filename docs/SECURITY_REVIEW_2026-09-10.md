# Tenant isolation security review — 2026-09-10

This patch closes reproduced application-level paths for cross-organization disclosure and session misuse. It is a source review with local automated verification, not a production penetration test or a certification for handling classified information. Production infrastructure, access logs, historical exposure, backups and third-party accounts were not inspected or changed.

## Reproduced problems and changes

| Problem | Result after this patch | Regression evidence |
| --- | --- | --- |
| File thumbnail endpoint accepted an unauthenticated file ID and queried globally. | Authentication and organization ownership are required; responses use `no-store`. Frontend thumbnails use authenticated fetches. | `test_tenant_security.py`: unauthenticated, foreign and owner thumbnail requests. |
| Moonraker state and metadata caches used LAN URL alone. Farms commonly reuse the same private IP. | Local and Redis keys include organization identity; old global keys are ignored. | `test_tenant_cache_security.py`: same IP, different farms, metadata, bed state and tunnel cache. |
| Bambu state, AMS, acknowledgments and device routing used serial number alone. | Cache keys, MQTT connection ownership, report/job matching and command relay carry organization identity. Camera sidecar names also include it. | Same-serial cross-tenant tests, command routing tests and cloud-job matching tests. |
| JWT decoding did not restrict the token purpose across all transports; old sessions could survive account changes. | Only typed access tokens authenticate. HTTP, camera, slicer JWT and WebSocket authentication check current account, organization, role and session version. Password/security changes revoke sessions and API keys. | Email-purpose token rejection, moved/disabled accounts, password reset, API key revocation, open stream revocation. |
| Agent Telegram commands and link claims could look up users across organizations; a payload could choose the bot organization. | Queries use the authenticated agent organization; agent credentials and connection require tenant admin. Foreign tunnel responses cannot complete another tenant's pending request. | Foreign Telegram chat/link, agent payload and tunnel response tests. |
| A tenant admin could invoke the all-organization daily-report endpoint. | Platform admin is required. | Global report authorization test. |
| Browser printer cache could survive account changes; slicer upload minted a browser JWT in a URL. | Persistent printer snapshots are removed, private state is cleared on login/logout, other tabs reload on account changes, and slicer webviews use normal login. Redirect targets are restricted to internal paths. | `frontend/src/lib/security.test.ts`. |
| Credentials appeared in the briefing document; unsent email logs exposed links/tokens. | Credential values were removed from the working document; unsent email logs omit recipient and message content. Cloud MQTT verifies TLS certificates. | Email log regression test; source review. |

## Validation

- Full backend suite: **420 passed** after tenant scoping changes.
- Final focused tenant-security suite: **37 passed**, including three additional camera tests (separate names, denied foreign access, termination after session revocation).
- Backend `ruff check .`: passed from `backend/`.
- Frontend Bun tests: **66 passed**. Production build: passed.
- Frontend lint: **9 errors, 180 warnings**. The errors are in unchanged `BrowserPrint.min.js`, design-system page, `LabelGeneratorModal.tsx` and `ScheduleCalendar.tsx`; they are not resolved by this security patch.
- Alembic upgrades through **0086** passed on a separate local migration database. This does not validate a production database upgrade or its lock duration.
- Static call-site inspection found no direct Bambu/Moonraker/go2rtc calls missing the newly required organization argument.
- Graph refresh unavailable: this checkout has no `.venv-graphify/bin/graphify` and no installed `graphify` command.

## Deployment requirements

1. Back up the production database and verify deployment secrets meet the new production validation: `SECRET_KEY` at least 32 bytes and non-default; `ADMIN_PASSWORD` at least 12 characters and non-default; `ENCRYPTION_KEY` present.
2. Coordinate the backend and worker update. Apply migration `0086` before new code serves requests, and restart all backend/worker instances together. The Bambu command envelope and cache keys changed; mixed versions are not supported.
3. Deploy the frontend together with the API change so thumbnails send authentication.
4. Reauthenticate users and local agents. Existing JWTs lack the required purpose/version claims and are rejected. Agent connections now require a tenant-admin account. Slicer API keys continue to work unless revoked, but the slicer browser view requires a normal login.
5. Validate two separate organizations in staging, including same-LAN-IP printer status, thumbnails, Telegram and camera access. Physical printer commands and live cloud/TLS connectivity were not exercised locally.
6. Rotate any still-active passwords/access codes previously present in `docs/AGENT_BRIEFING.md`. Removing working-tree text does not erase Git history or invalidate credentials.

This task did not deploy these changes or rotate production credentials.

## Remaining confidentiality boundaries

These are follow-up engineering and infrastructure work, not guarantees supplied by this patch:

- Browser access tokens remain in localStorage, with the existing 30-day default lifetime. WebSocket/camera URLs still carry tokens; proxy/application access-log redaction and a safer browser/agent credential design need separate work. Open WebSocket sessions recheck every 30 seconds; cameras recheck before forwarding a frame after that interval.
- Platform administrators retain intentional read-only organization impersonation. Tenant isolation does not protect customer data from platform operators with database/storage access. An isolated deployment and a defined operator-access policy are separate requirements for customers who cannot accept that trust model.
- S3 signed URLs are bearer capabilities with a default one-hour lifetime; revoking a login does not revoke already issued storage URLs. Objects, bucket policy and retention were not audited.
- `Printer.bambu_access_code` remains a plain database string; this patch does not add encryption of printer access codes. LAN device TLS still uses existing self-signed-certificate behavior.
- Printer URLs and agent proxy/network reachability need a dedicated SSRF/egress review. Full authorization coverage of every warehouse and integration endpoint, MFA/session management, database-level tenant constraints/RLS, dependency auditing and external penetration testing remain outside the verified coverage here.
- Shared Redis, database, storage, backups, Telegram and Bambu Cloud are trust boundaries. No production isolation, firewall, audit-retention or incident investigation was performed. Passing tests cannot establish whether data was accessed before the fixes.
