---
paths:
  - "agent/**"
  - "backend/app/api/agent.py"
  - "backend/app/api/agent_devices.py"
  - "backend/app/api/agent_tg.py"
  - "backend/app/models/agent.py"
  - "backend/app/services/agent_auth.py"
  - "backend/app/services/agent_commands.py"
  - "backend/app/services/tunnel.py"
---

# Local farm agent

## Version bump — three files, always together

When changing shipped agent behaviour, bump `AGENT_VERSION` in all three files:

- `agent/monofarm_agent.py`
- `agent/monofarm_tray.py`
- `backend/app/api/agent.py`

Forgetting one causes an update loop. A release is not complete until the exact
source-runtime allowlists, PyInstaller hidden imports, installers and signed
manifest all contain every imported runtime module; `agent/test_distribution.py`
and `backend/tests/integration/test_agent_exe.py` enforce that set.

## Authentication and pairing

New installs use a one-time pairing code and a dedicated `AgentDevice` identity.
The long-lived device secret stays in `~/.monofarm-agent/.env`; the agent mints a
five-minute scoped JWT via `/api/agent/v2/token`. Never persist a user JWT in the
tray, return it to browser JavaScript, or add credentials to log messages.

`/api/agent/connect` with a user JWT is migration-only. New clients connect to
`/api/agent/v2/connect`. Revocation and credential rotation must fail closed;
the server watchdog revalidates the device from a fresh DB session.

## Two protocol planes

The v2 control plane is the source of truth for physical side effects:

1. admin creates a typed command;
2. the agent leases it from `/api/agent/v2/commands/pull`;
3. the command is persisted to SQLite before execution;
4. the provider adapter uses only fixed targets from `/api/agent/v2/runtime-config`;
5. ACK milestones and a monotonic event outbox are sent back to the cloud;
6. ambiguous starts enter `needs_reconcile` and must never be blindly replayed.

Long-running commands renew their active lease. Expired active leases are
recoverable after a crash, while `printer.start` remains quarantined for an
explicit semantic reconcile.

The WebSocket relay remains for live state, cameras, discovery and legacy
calls. Its historical envelope is fixed:

```python
# Regular
server_to_agent = {"id": "…", "method": "GET|POST|…", "url": "…", "body": None}
agent_to_server = {"id": "…", "status": 200, "body": {}, "error": None}

# Streaming
server_to_agent = {"id": "…", "method": "STREAM", "url": "…"}
agent_to_server = {"id": "…", "type": "stream_start", "status": 200}
agent_to_server = {"id": "…", "type": "chunk", "data": "<base64>"}
agent_to_server = {"id": "…", "type": "stream_end"}
```

Do not add a general-purpose LAN proxy. Legacy HTTP requests are restricted to
registered private printer targets and explicit methods; raw TCP is restricted
to configured ZPL targets. The local setup UI is loopback-only with Host/Origin
validation.

## Provider adapters

Operational and tested-in-code adapters are:

- Bambu LAN: P1S, A1 and A1 mini over implicit FTPS + MQTT;
- Moonraker/Klipper: generic Klipper and Snapmaker U1.

Provider implementations live in `agent/provider_adapters.py`; fixed target and
strict command dispatch live in `agent/printer_runtime.py`. Adding a brand means
adding a typed adapter, descriptor, capability/transport metadata, contract
tests, protocol fixtures and live hardware certification. Do not label a brand
operational based only on discovery or a guessed payload.

Slot indexing remains 0-based. Bambu starts require semantic task correlation;
Moonraker starts require exact filename plus printer state. MQTT PUBACK or an
HTTP 2xx alone is not proof that printing started.

Durable Moonraker dispatch is byte-for-byte only. Identity slot maps on generic
Moonraker printers are allowed; any non-identity remap, print-option override,
`calibrate_slots`, metadata-driven unused-slot filtering, or Snapmaker U1 slot
mapping must fall back before file reads or job mutation to the existing
transforming dispatcher. Validate upload/start/reconcile against
`provider=moonraker` and the exact filename. Leave an agent-confirmed job in
`acknowledged` so `print_tracker` remains the lifecycle owner.

Printer ownership is explicit through `Printer.agent_device_id`. A site-scoped
device must never receive an unassigned printer. The sole unscoped device may
inherit unassigned printers only as the migration compatibility path.

## Artifacts and durability

Artifacts download to a per-device spool using HTTPS, a server-provided host
allowlist, expected size, SHA-256, quota checks, bounded 64 KiB reads, `.part`
resume and atomic rename. Never buffer a print file in RAM. Command and event
state lives in the per-device SQLite journal under `CONFIG_DIR/runtime/`.

## One canonical loop

`monofarm_agent.run(...)` is the only relay/runtime loop. The tray is a thin GUI
host. Do not add a second dispatch loop to the tray.

Reconnect logic belongs to the outer loop. A reconnect creates a new command
worker over the same device journal, refreshes runtime config, restarts local
printer subscriptions and flushes the durable event outbox.

## Configuration storage

All local writes go through atomic merge-based config helpers. Never replace
`~/.monofarm-agent/.env` with a partial mapping. Device identity, update trust
keys and alert chat IDs must survive updates and re-pairing.

TLS verification is the default. Per-target insecure exceptions are explicit
operator configuration (`MONOFARM_BAMBU_INSECURE_TARGETS` and
`MONOFARM_MOONRAKER_INSECURE_TARGETS`), never an automatic retry path.

## Distribution and OTA

- Windows: PyInstaller executable built by `.github/workflows/agent-build.yml`.
- Linux/Pi: atomic versioned source releases installed by `agent/install.sh`.
- Legacy single-file installs migrate through `agent/legacy_bootstrap.py`.
- OTA manifests are Ed25519-signed and every artifact has exact size + SHA-256.

The update signing private key is CI-only and must never be available to the
backend. The matching public trust root is committed in
`agent/release_public_key.b64` and must stay byte-for-byte identical in the
legacy bootstrap, runtime, installers, backend and frontend. CI writes one
immutable, full-release manifest after all versioned artifacts; the backend
verifies it and serves it verbatim. Existing single-file agents receive the
one-time bootstrap over the historical HTTPS route; that bootstrap pins the
committed key before activating any modular runtime. All subsequent installs
and updates reject unsigned, stale, downgraded or partial bundles. Keep the
historical bootstrap route until the deployed v1 fleet has migrated.

On a `main` push, CI must publish a changed agent version before the existing
production deploy workflow may run. Runtime changes without an
`AGENT_VERSION` bump fail CI. Never bypass that gate or overwrite an immutable
release object.

## Telegram and cameras

Paired devices use `/api/agent/v2/tg-*`; v1 endpoints exist only for migration.
Telegram sending, failure detection and local snapshots stay on the agent.
Camera/live streams are bounded and cancellable; disconnect cleanup must cancel
all producers and printer subscriptions.
