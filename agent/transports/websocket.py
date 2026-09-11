"""Cloud WebSocket protocol parsing and command dispatch."""
from __future__ import annotations

import asyncio
import json
import logging

import httpx

from core.state import LOG_BUFFER, runtime_state
from printers import anycubic, bambu, moonraker
from printers.zpl import handle_print_zpl
from transports import telegram
from transports.http import (
    handle_discover_moonraker,
    handle_ffmpeg_stream,
    handle_request,
    handle_stream,
)


log = logging.getLogger("monofarm-agent")
AGENT_CAPABILITIES = (
    "moonraker_upload_chunks",
    "moonraker_upload_url",
    "moonraker_upload_local_transform",
)


def parse_message(message: str) -> dict | None:
    try:
        request = json.loads(message)
    except json.JSONDecodeError:
        log.warning("Received invalid JSON from server")
        return None
    if not isinstance(request, dict):
        log.warning("Received non-object message from server")
        return None
    return request


async def send_hello(websocket, agent_version: str) -> None:
    await websocket.send(
        json.dumps(
            {
                "type": "AGENT_HELLO",
                "version": agent_version,
                "capabilities": list(AGENT_CAPABILITIES),
            }
        )
    )


async def refresh_telegram_config(server: str, token: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{server}/api/agent/tg-config",
                headers={"Authorization": f"Bearer {token}"},
            )
        if response.status_code == 200:
            config = response.json()
            asyncio.create_task(telegram.reconfigure(config.get("token") or None))
    except Exception as exc:
        log.debug("Could not fetch tg-config: %s", exc)


def start_printer_config_tasks(websocket, server: str, token: str) -> tuple[asyncio.Task, ...]:
    return (
        asyncio.create_task(bambu._bambu_lan_config_loop(websocket, server, token)),
        asyncio.create_task(anycubic._anycubic_config_loop(websocket, server, token)),
    )


async def _handle_agent_logs(websocket, request: dict, agent_version: str) -> None:
    await websocket.send(
        json.dumps(
            {
                "id": request.get("id"),
                "status": 200,
                "body": {
                    "version": agent_version,
                    "lines": list(LOG_BUFFER)[-200:],
                },
                "error": None,
            }
        )
    )


async def dispatch_message(websocket, request: dict, agent_version: str) -> None:
    """Dispatch one decoded server message without changing its wire shape."""
    message_type = request.get("type", "")
    if message_type == "TG_CONFIG":
        asyncio.create_task(telegram.reconfigure(request.get("token") or None))
        return
    if message_type == "TG_SEND":
        asyncio.create_task(telegram.send_cloud_message(request))
        return

    method = request.get("method", "GET").upper()
    if method == "MOONRAKER_SUBSCRIBE":
        asyncio.create_task(moonraker.handle_moonraker_subscribe(websocket, request))
    elif method == "BAMBU_CAMERA":
        asyncio.create_task(bambu.handle_bambu_camera(websocket, request))
    elif method == "FFMPEG_STREAM":
        asyncio.create_task(handle_ffmpeg_stream(websocket, request))
    elif method == "DISCOVER_BAMBU":
        asyncio.create_task(bambu.handle_discover_bambu(websocket, request))
    elif method == "DISCOVER_MOONRAKER":
        asyncio.create_task(handle_discover_moonraker(websocket, request))
    elif method == "BAMBU_UPLOAD":
        asyncio.create_task(bambu.handle_bambu_upload(websocket, request))
    elif method == "BAMBU_MQTT":
        asyncio.create_task(bambu.handle_bambu_mqtt(websocket, request))
    elif method == "ANYCUBIC_MQTT":
        asyncio.create_task(anycubic.handle_anycubic_command(websocket, request))
    elif method == "MOONRAKER_UPLOAD":
        if request.get("chunked"):
            runtime_state.upload_buffers[request["id"]] = {
                "meta": request,
                "data": bytearray(),
                "next_offset": 0,
                "total_bytes": int(request.get("total_bytes", 0)),
            }
        else:
            asyncio.create_task(moonraker.handle_moonraker_upload(websocket, request))
    elif method == "MOONRAKER_UPLOAD_CHUNK":
        await moonraker.handle_moonraker_upload_chunk(websocket, request)
    elif method == "PRINT_ZPL":
        asyncio.create_task(handle_print_zpl(websocket, request))
    elif method == "AGENT_LOGS":
        asyncio.create_task(_handle_agent_logs(websocket, request, agent_version))
    elif method == "STREAM":
        asyncio.create_task(handle_stream(websocket, request))
    else:
        asyncio.create_task(handle_request(websocket, request))


def disconnect(background_tasks: tuple[asyncio.Task, ...]) -> None:
    runtime_state.cloud_connected = False
    moonraker._cancel_all_subscriptions()
    bambu._cancel_all_bambu_lan_subscriptions()
    anycubic._cancel_all_anycubic_subscriptions()
    runtime_state.upload_buffers.clear()
    for task in background_tasks:
        task.cancel()
