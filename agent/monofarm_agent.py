#!/usr/bin/env python3
# ruff: noqa: F401
"""monofarm edge-agent compatibility entrypoint.

The implementation lives in core, transports, and printers packages. This
module keeps the historical CLI and import surface used by the tray host.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import logging
import os
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

# Direct execution and the frozen tray load this file as a top-level module.
_AGENT_DIR = Path(__file__).resolve().parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))


def _configured_server_for_bootstrap() -> str:
    for index, argument in enumerate(sys.argv[1:]):
        if argument.startswith("--server="):
            return argument.partition("=")[2].rstrip("/")
        if argument == "--server" and index + 2 < len(sys.argv):
            return sys.argv[index + 2].rstrip("/")
    config_file = Path.home() / ".monofarm-agent" / ".env"
    if config_file.exists():
        for line in config_file.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() == "MONOFARM_SERVER" and value.strip():
                return value.strip().rstrip("/")
    return "https://api.monofarm.app"


def _extract_source_bundle(payload: bytes, destination: Path) -> None:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for name in archive.namelist():
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"unsafe source archive path: {name}")
        archive.extractall(destination)


def _bootstrap_package_tree() -> None:
    """Migrate pre-0.8.16 flat source installs to the package layout."""
    if getattr(sys, "frozen", False) or (_AGENT_DIR / "core" / "runtime.py").is_file():
        return
    server = _configured_server_for_bootstrap()
    with urllib.request.urlopen(f"{server}/agent/source.zip", timeout=30) as response:
        _extract_source_bundle(response.read(), _AGENT_DIR)
    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--quiet",
                "-r",
                str(_AGENT_DIR / "requirements-core.txt"),
            ],
            check=False,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logging.getLogger("monofarm-agent").warning(
            "Package bootstrap dependency refresh failed: %s",
            exc,
        )


_bootstrap_package_tree()

from core.config import (  # noqa: E402
    CONFIG_DIR,
    CONFIG_FILE,
    _load_alert_chat_ids,
    _load_config,
    _save_alert_chat_ids,
    _save_config,
    _write_config,
)
from core.lifecycle import acquire_single_instance, setup_file_logging  # noqa: E402
from core.runtime import _pair_flow, run as _run  # noqa: E402
from core.state import LOG_BUFFER as _LOG_BUFFER  # noqa: E402
from core.state import runtime_state  # noqa: E402
from core.updates import (  # noqa: E402
    UPDATE_INTERVAL,
    _apply_frozen_update,
    _apply_source_update,
    cleanup_old_exe,
    check_for_update as _check_for_update,
)
from printers.anycubic import (  # noqa: E402
    _ANYCUBIC_STATUS_POLL_INTERVAL,
    _anycubic_live_clients,
    _anycubic_poll_requests,
    handle_anycubic_command,
)
from printers.bambu import (  # noqa: E402
    BAMBU_FTPS_CONNECT_ATTEMPTS,
    BAMBU_FTPS_CONNECT_TIMEOUT,
    BAMBU_FTPS_IO_TIMEOUT,
    BAMBU_FTPS_RETRY_DELAY,
    MQTT_SUCCESS_RC,
    _bambu_lan_live_clients,
    _bambu_mark_tls_failure,
    _bambu_mqtt_publish_blocking,
    _bambu_publish_via_live_client,
    _bambu_ssl_context,
    _connect_bambu_ftps_with_retry,
    ensure_bambu_mqtt_dependency,
    handle_bambu_camera,
    handle_bambu_mqtt,
    handle_bambu_upload,
    handle_discover_bambu,
)
from printers.moonraker import (  # noqa: E402
    MOONRAKER_UPLOAD_HEARTBEAT_INTERVAL,
    apply_moonraker_print_options,
    handle_moonraker_subscribe,
    handle_moonraker_upload,
    handle_moonraker_upload_chunk,
)
from printers.zpl import handle_print_zpl  # noqa: E402
from transports.http import (  # noqa: E402
    REQUEST_TIMEOUT,
    STREAM_CHUNK,
    handle_discover_moonraker,
    handle_ffmpeg_stream,
    handle_request,
    handle_stream,
)
from transports.telegram import stop as _tg_stop  # noqa: E402
from transports.web_ui import start_web_ui as _start_web_ui_impl  # noqa: E402


AGENT_VERSION = "0.8.16"
WEB_PORT_DEFAULT = 8723
RECONNECT_DELAY = 5

log = logging.getLogger("monofarm-agent")


async def check_for_update(server: str) -> None:
    await _check_for_update(server, AGENT_VERSION)


async def run(
    server: str,
    token: str,
    *,
    on_state=None,
    run_updates: bool = True,
) -> None:
    """Run the one canonical relay loop used by the CLI and tray."""
    await _run(
        server,
        token,
        agent_version=AGENT_VERSION,
        on_state=on_state,
        run_updates=run_updates,
    )


def _start_web_ui(port: int) -> None:
    runtime_state.version = AGENT_VERSION
    _start_web_ui_impl(port)


_cleanup_old_exe = cleanup_old_exe


def main() -> None:
    parser = argparse.ArgumentParser(
        description="monofarm local agent — tunnels printer and camera access to the cloud",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python monofarm_agent.py                                    # pair via browser (first run)
  python monofarm_agent.py --server http://192.168.1.10:8000 # custom server, pair via browser
  python monofarm_agent.py --token eyJ...                    # skip pairing, use token directly

On first run without --token the browser opens to monofarm Settings automatically.
Token is saved to ~/.monofarm-agent/.env — subsequent runs need no arguments.
        """,
    )
    parser.add_argument(
        "--server",
        default=None,
        help="monofarm server URL (default: saved config or https://api.monofarm.app)",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="JWT token — omit to use saved config or pair via browser",
    )
    args = parser.parse_args()

    cleanup_old_exe()
    setup_file_logging()
    if not acquire_single_instance():
        log.error("Another monofarm-agent is already running — exiting.")
        sys.exit(0)

    config = _load_config()
    server = args.server or config["MONOFARM_SERVER"]
    token = args.token or config["MONOFARM_TOKEN"]

    try:
        web_port = int(
            os.environ.get("MONOFARM_WEB_PORT")
            or config.get("MONOFARM_WEB_PORT")
            or WEB_PORT_DEFAULT
        )
    except ValueError:
        web_port = WEB_PORT_DEFAULT
    if web_port > 0:
        _start_web_ui(web_port)

    async def _main_loop() -> None:
        current_token = token or await _pair_flow(server)
        try:
            await run(server, current_token)
        finally:
            await _tg_stop()

    try:
        asyncio.run(_main_loop())
    except KeyboardInterrupt:
        log.info("Agent stopped.")


if __name__ == "__main__":
    main()
