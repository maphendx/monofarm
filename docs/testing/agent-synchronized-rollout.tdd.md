# Agent synchronized rollout — TDD evidence

## Goal

Deploy backend, frontend and agent as one fail-closed production change while
allowing legacy Linux agents to migrate without a manually provisioned public
key.

## RED

- `agent.test_release_sync` failed because no committed trust root, built-in
  bootstrap key, reusable release workflow or CI release gate existed.
- `backend/tests/unit/test_agent_release_trust.py` failed because backend trust
  resolution did not exist.
- frontend fleet/trust tests failed because the release-health, assignment and
  committed-key modules did not exist.
- the Windows installer test failed because an out-of-band SHA-256 was mandatory.

## GREEN contract

- One Ed25519 public key is identical across the committed key file, both agent
  runtimes, both installers, backend and frontend.
- Empty local configuration falls back to the committed key; an explicit
  mismatched backend key fails closed.
- A main-branch agent runtime diff requires an `AGENT_VERSION` bump and a signed
  immutable release before production deploy can succeed.
- Settings exposes release readiness, per-device version health and explicit
  printer assignments.
- Windows and Linux first installs work from the production HTTPS origin with
  the pinned key; activated payloads require the signed manifest and digest.

## Verification

- Backend Ruff: passed.
- Backend unit suite: `223 passed`.
- Agent suite without sandbox-only loopback binding and optional tray GUI
  import: `196 passed, 1 deselected, 58 subtests passed`.
- Release/bootstrap/distribution focus: `48 passed`.
- Frontend unit suite: `39 passed`; changed Settings/release modules lint with
  zero errors.
- Workflow YAML and trust-key parity tests: passed.

The local full backend integration run cannot connect to the test Postgres from
the restricted execution sandbox. The local Next production build reaches font
resolution and then cannot access `fonts.googleapis.com`; CI remains the hard
build/migration gate. A main push is intentionally blocked until the generated
private signing key is installed as the GitHub Actions secret.
