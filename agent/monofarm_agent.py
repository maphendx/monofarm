#!/usr/bin/env python3
"""monofarm-agent — local network tunnel for Moonraker printers.

Runs on a Raspberry Pi or any PC on the same network as your printers.
Makes an outbound WebSocket connection to monofarm cloud so the server
can reach local Moonraker instances without port forwarding.

Usage:
    python monofarm_agent.py --server https://monofarm.app --token YOUR_JWT_TOKEN

Install deps:
    pip install websockets httpx

Docker:
    docker run --network host monofarm/agent --token YOUR_JWT_TOKEN
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

try:
    import httpx
    import websockets
    import websockets.exceptions
except ImportError:
    print("Missing dependencies. Run: pip install websockets httpx")
    sys.exit(1)


log = logging.getLogger("monofarm-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

RECONNECT_DELAY = 5   # seconds between reconnect attempts
REQUEST_TIMEOUT = 10  # seconds per proxied HTTP request


async def handle_request(ws, req: dict) -> None:
    """Proxy a single HTTP request and send the response back."""
    req_id = req.get("id")
    url = req.get("url", "")
    method = req.get("method", "GET").upper()
    body = req.get("body")

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, verify=False) as client:  # noqa: S501
            resp = await client.request(method, url, json=body)
            try:
                resp_body = resp.json()
            except Exception:
                resp_body = {"raw": resp.text}
            result = {"id": req_id, "status": resp.status_code, "body": resp_body, "error": None}
    except httpx.TimeoutException:
        log.warning("Timeout proxying %s %s", method, url)
        result = {"id": req_id, "status": 504, "body": None, "error": "timeout"}
    except Exception as e:
        log.warning("Error proxying %s %s: %s", method, url, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}

    await ws.send(json.dumps(result))


async def run(server: str, token: str) -> None:
    ws_url = (
        server.replace("https://", "wss://").replace("http://", "ws://")
        + f"/api/agent/connect?token={token}"
    )
    log.info("Connecting to %s …", server)

    while True:
        try:
            async with websockets.connect(
                ws_url,
                ping_interval=20,
                ping_timeout=10,
                open_timeout=15,
            ) as ws:
                log.info("Connected to monofarm cloud ✓  (waiting for requests…)")
                async for message in ws:
                    try:
                        req = json.loads(message)
                    except json.JSONDecodeError:
                        log.warning("Received invalid JSON from server")
                        continue
                    # handle each request concurrently — don't block the WS loop
                    asyncio.create_task(handle_request(ws, req))

        except websockets.exceptions.InvalidStatusCode as e:
            if e.status_code in (4001, 4002):
                log.error("Authentication failed (code %s). Check your --token.", e.status_code)
                sys.exit(1)
            log.warning("Server rejected connection (%s). Retrying in %ss…", e.status_code, RECONNECT_DELAY)
        except (OSError, websockets.exceptions.WebSocketException) as e:
            log.warning("Disconnected: %s. Retrying in %ss…", e, RECONNECT_DELAY)
        except Exception as e:
            log.exception("Unexpected error: %s", e)

        await asyncio.sleep(RECONNECT_DELAY)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="monofarm local agent — tunnels Moonraker access to the cloud",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python monofarm_agent.py --token eyJ...
  python monofarm_agent.py --server https://my.monofarm.app --token eyJ...

Get your token in monofarm → Settings → Agent Connection.
        """,
    )
    parser.add_argument(
        "--server",
        default="https://monofarm.app",
        help="monofarm server URL (default: https://monofarm.app)",
    )
    parser.add_argument(
        "--token",
        required=True,
        help="Your monofarm JWT token (from Settings → Agent Connection)",
    )
    args = parser.parse_args()

    try:
        asyncio.run(run(args.server, args.token))
    except KeyboardInterrupt:
        log.info("Agent stopped.")


if __name__ == "__main__":
    main()
