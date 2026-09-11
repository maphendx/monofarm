# Edge agent architecture

The edge agent is a package with a compatibility entrypoint. The tray and
Linux service still import or execute monofarm_agent.py; printer logic and
transport lifecycles no longer live in that file.

## Module boundaries

| Area | Responsibility |
| --- | --- |
| agent/monofarm_agent.py | Stable CLI/import facade, version, first package migration |
| agent/core/config.py | Atomic environment configuration reads and writes |
| agent/core/state.py | Small shared runtime snapshot and bounded log buffer |
| agent/core/runtime.py | Pairing, reconnect loop, canonical connection lifecycle |
| agent/core/updates.py | Frozen executable and complete source-tree updates |
| agent/transports/websocket.py | Cloud message parsing, hello envelope, command dispatch and disconnect cleanup |
| agent/transports/http.py | Generic HTTP relay, Moonraker discovery and MJPEG/FFmpeg streams |
| agent/transports/telegram.py | Local bot, alert registration, state classification and alert delivery |
| agent/transports/web_ui.py | Trusted-LAN configuration and diagnostics UI |
| agent/printers/bambu.py | Bambu TLS, MQTT, camera, SSDP and FTPS |
| agent/printers/moonraker.py | Moonraker state subscriptions, snapshots and uploads |
| agent/printers/anycubic.py | Anycubic handshake, MQTT monitor and commands |
| agent/printers/zpl.py | Raw network label printing |

core/runtime.py owns reconnection. transports/websocket.py owns server message
dispatch. Printer modules own their connection tasks and cancel them when the
cloud socket closes. The backend remains a relay and cache; image, alert and
printer work stays at the edge.

## Compatibility

- monofarm_agent.run(server, token, on_state=..., run_updates=...) remains the
  canonical tray and CLI entrypoint.
- The request, response, stream and camera message envelopes are unchanged.
- AGENT_VERSION is 0.8.16 in the facade, tray and backend version endpoint.
- Existing 0.8.15 source agents first receive the small facade through their
  legacy flat-file updater. If package modules are absent, the facade downloads
  /agent/source.zip from the configured server and installs the package tree.
- New Linux/Pi installs and later source updates use /agent/source.zip.
  source_manifest.json defines its exact contents; archive paths are checked
  before extraction. The version-bearing entrypoint is replaced last during
  normal source updates.
- PyInstaller keeps monofarm_tray.py as the entrypoint and explicitly includes
  the new core, transport and printer packages.

## Validation

Agent tests cover existing Anycubic, Bambu and Moonraker helpers plus the hello
envelope, generic dispatch, chunked-upload state and archive path validation.
The backend archive test checks that the served ZIP matches its manifest and
that facade, tray and API versions agree.

No real printer, camera, Telegram bot, Linux service install, or Windows
PyInstaller build runs in local automated tests. The Windows executable still
requires the Windows CI runner.
