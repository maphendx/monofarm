"""Direct network ZPL printing."""
from __future__ import annotations

import asyncio
import json
import logging

log = logging.getLogger("monofarm-agent")


async def handle_print_zpl(ws, req: dict) -> None:
    """Send raw ZPL to a network printer via TCP port 9100 (or custom port)."""
    req_id = req.get("id")
    body   = req.get("body") or {}
    ip     = body.get("ip", "")
    port   = int(body.get("port", 9100))
    zpl    = body.get("zpl", "")
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=5
        )
        writer.write(zpl.encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        result = {"id": req_id, "status": 200, "body": {"ok": True}, "error": None}
        log.info("PRINT_ZPL: sent %d bytes to %s:%s", len(zpl), ip, port)
    except Exception as e:
        log.warning("PRINT_ZPL error %s:%s: %s", ip, port, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}
    await ws.send(json.dumps(result))
