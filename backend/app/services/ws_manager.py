"""WebSocket connection manager — org-scoped broadcast.

Keeps track of active WebSocket sessions per organization. Allows the
Bambu MQTT callback (and future events) to push updates to all connected
clients without polling.
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

log = logging.getLogger(__name__)

PRINTER_EVENTS_CHANNEL = "printer:events"


class WsManager:
    def __init__(self) -> None:
        self._connections: dict[int, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket, org_id: int) -> None:
        await ws.accept()
        async with self._lock:
            self._connections[org_id].add(ws)

    async def disconnect(self, ws: WebSocket, org_id: int) -> None:
        async with self._lock:
            self._connections[org_id].discard(ws)

    async def broadcast(self, org_id: int, message: dict) -> None:
        """Push a JSON message to every connected client in this org."""
        async with self._lock:
            sockets = set(self._connections.get(org_id, set()))
        if not sockets:
            return
        dead: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._connections[org_id].discard(ws)

    def has_clients(self, org_id: int) -> bool:
        return bool(self._connections.get(org_id))


manager = WsManager()
