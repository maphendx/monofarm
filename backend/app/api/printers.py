"""Printer endpoints.

Strategy: DB stores persistent printer rows (name, kind, manual state).
Bambu live state comes from MQTT cache; Moonraker from REST polling.
"""
import asyncio
import base64
import logging
from datetime import datetime, timezone

import httpx
import requests as _requests
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.plan import PlanEntry
from app.models.printer import Printer, PrinterKind
from app.models.printer_group import PrinterGroup
from app.models.task import PrintTask
from app.models.user import User, UserRole
from app.schemas.printer import (
    FilamentSlot,
    PrinterCreate,
    PrinterGroupAssign,
    PrinterManualUpdate,
    PrinterOut,
    PrinterReorderItem,
    PrinterUpdate,
)
from app.services import bambu, moonraker, tunnel as _tunnel

log = logging.getLogger(__name__)


class ClearBedPayload(BaseModel):
    success: bool = True


class AutoPrintSettings(BaseModel):
    enabled: bool
    plates_loaded: int = 1
    cooldown_temp_c: int = 40
    delay_seconds: int = 0
    eject_last_plate: bool = True


class SendGcodePayload(BaseModel):
    gcode: list[str]


import re


# Known Bambu build volumes (X × Y × Z in mm). Matched by substring in bambu_model.
_BAMBU_VOLUMES: list[tuple[str, tuple[int, int, int]]] = [
    ("A1 mini", (180, 180, 180)),
    ("A1",      (256, 256, 256)),
    ("P1S",     (256, 256, 256)),
    ("P1P",     (220, 220, 220)),
    ("X1C",     (256, 256, 256)),
    ("X1E",     (256, 256, 256)),
    ("H2D",     (350, 320, 325)),
]


def _bambu_build_volume(model: str | None) -> tuple[int, int, int] | None:
    if not model:
        return None
    m = model.lower()
    for key, vol in _BAMBU_VOLUMES:
        if key.lower() in m:
            return vol
    return None


def _default_nozzle(kind: "PrinterKind", model: str | None) -> float | None:
    """Return the factory nozzle diameter for known printer models.

    All standard Bambu Lab and Snapmaker U1 printers ship with a 0.4 mm nozzle.
    Returns None for unknown/generic printers so we don't silently override a
    custom nozzle the user may have installed.
    """
    if kind == PrinterKind.snapmaker_u1:
        return 0.4
    if kind == PrinterKind.bambu and model:
        m = model.lower()
        if any(key.lower() in m for key, _ in _BAMBU_VOLUMES):
            return 0.4
    return None


def _jpeg_from_mjpeg_chunk(chunk: bytes) -> bytes | None:
    start = chunk.find(b"\xff\xd8")
    end = chunk.find(b"\xff\xd9", start + 2)
    if start == -1 or end == -1:
        return None
    return chunk[start : end + 2]


def _natural_key(s: str) -> list:
    """Split a string into text/number chunks so A11 sorts after A10, not after A1."""
    return [int(chunk) if chunk.isdigit() else chunk.lower() for chunk in re.split(r"(\d+)", s)]


router = APIRouter(prefix="/printers", tags=["printers"])



def _sync_bambu_rows(db: Session, devices: list[dict], org_id: int) -> dict[str, Printer]:
    """Sync metadata (name, access_code, model) for already-claimed Bambu devices.
    Does NOT auto-create new rows — use claim_bambu_printer for that."""
    if not devices:
        return {}
    dev_ids = [d["dev_id"] for d in devices]
    existing = {
        p.bambu_dev_id: p
        for p in db.query(Printer).filter(
            Printer.bambu_dev_id.in_(dev_ids),
            Printer.organization_id == org_id,
        )
    }
    dirty = False
    for d in devices:
        did = d["dev_id"]
        if did not in existing:
            continue
        row = existing[did]
        if row.name != d["name"]:
            row.name = d["name"]
            dirty = True
        if d.get("dev_access_code") and row.bambu_access_code != d["dev_access_code"]:
            row.bambu_access_code = d["dev_access_code"]
            dirty = True
        model = d.get("dev_product_name") or d.get("dev_model_name") or ""
        if model and row.bambu_model != model:
            row.bambu_model = model
            dirty = True
        if row.nozzle_diameter is None:
            nd = _default_nozzle(PrinterKind.bambu, row.bambu_model)
            if nd is not None:
                row.nozzle_diameter = nd
                dirty = True
    if dirty:
        db.commit()
    return existing


def _resolve_filament_for_file(
    db: Session, filename: str | None, moonraker_url: str | None = None, org_id: int | None = None
) -> dict | None:
    """Find filament_meta for the file currently being printed.

    1. Local DB: PrintTask whose file_name matches (most recent if duplicates).
    2. Fallback: fetch from Moonraker — its metadata, then file tail.
    """
    if not filename:
        return None
    q = db.query(PrintTask).filter(PrintTask.file_name == filename, PrintTask.filament_meta.isnot(None))
    if org_id is not None:
        q = q.filter(PrintTask.organization_id == org_id)
    task = q.order_by(PrintTask.created_at.desc()).first()
    if task and task.filament_meta:
        return task.filament_meta
    # Fall back to Moonraker — for files uploaded outside our system
    if moonraker_url:
        remote = moonraker.get_remote_file_meta(moonraker_url, filename)
        return remote or None
    return None


def _to_dto(
    printer: Printer,
    db: Session | None = None,
    groups_by_id: dict[int, str] | None = None,
    prefetched_live: dict | None = None,
    prefetched_slots: list | None = None,
) -> PrinterOut:
    group_name: str | None = None
    if printer.group_id is not None:
        if groups_by_id is not None:
            group_name = groups_by_id.get(printer.group_id)
        elif db is not None:
            g = db.get(PrinterGroup, printer.group_id)
            group_name = g.name if g else None

    u1_slots: list[dict] | None = None
    if prefetched_slots is not None:
        if printer.kind == PrinterKind.snapmaker_u1:
            # Always show 4 slots for U1 (T0..T3), fill empties
            by_idx = {s["slot_index"]: s for s in prefetched_slots}
            u1_slots = [
                by_idx.get(i, {"slot_index": i, "state": "empty", "filament_id": None,
                               "material": None, "color": None, "hex_color": None,
                               "brand": None, "grams_at_load": None,
                               "unit_index": 0, "is_external": False})
                for i in range(4)
            ]
        else:
            # Bambu and others — return the slots as-is (sorted by slot_index)
            u1_slots = sorted(prefetched_slots, key=lambda s: s["slot_index"]) or None

    from app.services.firmware_matrix import get_features as _fw_features
    base = dict(
        id=printer.id,
        name=printer.name,
        kind=printer.kind,
        moonraker_url=printer.moonraker_url,
        bambu_dev_id=printer.bambu_dev_id,
        bambu_dev_ip=printer.bambu_dev_ip,
        bambu_model=printer.bambu_model,
        bambu_lan_mode=printer.bambu_lan_mode,
        is_active=printer.is_active,
        is_out_of_order=printer.is_out_of_order,
        sort_order=printer.sort_order,
        group_id=printer.group_id,
        group_name=group_name,
        loaded_filaments=printer.loaded_filaments or [],
        slots=u1_slots,
        firmware_version=printer.firmware_version,
        power_watts=printer.power_watts,
        firmware_features=_fw_features(printer.firmware_version) if printer.firmware_version else None,
        build_x=printer.build_x,
        build_y=printer.build_y,
        build_z=printer.build_z,
        nozzle_diameter=printer.nozzle_diameter,
        bed_type=printer.bed_type,
        last_gcode_file_id=printer.last_gcode_file_id,
        autoprint_mode=printer.autoprint_mode,
        autoprint_plates_remaining=printer.autoprint_plates_remaining,
        autoprint_cooldown_temp_c=printer.autoprint_cooldown_temp_c,
        autoprint_delay_seconds=printer.autoprint_delay_seconds,
        autoprint_eject_last_plate=printer.autoprint_eject_last_plate,
        autoprint_error=printer.autoprint_error,
        tags=printer.tags or [],
    )

    # Bambu Lab — live state from MQTT cache, AMS filaments from cache
    if printer.kind == PrinterKind.bambu and printer.bambu_dev_id:
        live = bambu.get_cached_state(printer.bambu_dev_id)
        ams_trays = bambu.get_ams_filaments(printer.bambu_dev_id)
        filaments = ams_trays if ams_trays else (printer.loaded_filaments or [])
        return PrinterOut(
            **{**base, "loaded_filaments": filaments},
            state=live.get("state") or "unknown",
            flags=[],
            job=live.get("filename"),
            eta_minutes=live.get("eta_minutes"),
            source="bambu",
            progress_pct=live.get("progress_pct"),
            extruder_temp=live.get("nozzle_temp"),
            extruder_target=live.get("nozzle_target"),
            bed_temp=live.get("bed_temp"),
            bed_target=live.get("bed_target"),
            error_msg=live.get("error_msg"),
            active_tray=live.get("active_tray"),
        )

    # Manual (U1, other) — if Moonraker URL is set, prefer live data
    if printer.moonraker_url:
        live = prefetched_live if prefetched_live is not None else moonraker.get_live_status(printer.moonraker_url)
        filename = live.get("filename") or printer.manual_job
        current_meta = (
            _resolve_filament_for_file(db, filename, printer.moonraker_url, printer.organization_id)
            if db
            else None
        )
        return PrinterOut(
            **base,
            state=live.get("state") or "unknown",
            flags=[],
            job=filename,
            eta_minutes=live.get("eta_minutes"),
            updated_at=printer.manual_updated_at,
            source="moonraker",
            progress_pct=live.get("progress_pct"),
            extruder_temp=live.get("extruder_temp"),
            extruder_target=live.get("extruder_target"),
            bed_temp=live.get("bed_temp"),
            bed_target=live.get("bed_target"),
            current_filament_meta=current_meta,
            error_msg=live.get("error_msg"),
        )

    return PrinterOut(
        **base,
        state=printer.manual_status or "idle",
        flags=[],
        job=printer.manual_job,
        eta_minutes=printer.manual_eta_minutes,
        updated_at=printer.manual_updated_at,
        source="manual",
    )


@router.get("/bambu-discover")
async def bambu_discover(
    org: Organization = Depends(get_current_org),
) -> list[dict]:
    """UDP LAN broadcast to find Bambu printers and their IPs.

    If the agent is connected, the discovery runs on the agent machine
    (same LAN as printers). Otherwise runs locally.
    """
    # ── Via agent tunnel (agent is on the farm network) ───────────────────────
    if _tunnel.has_tunnel(org.id):
        try:
            resp = await _tunnel.proxy_request(org.id, "DISCOVER_BAMBU", "", timeout=10.0)
            if resp.get("error") or resp.get("status", 0) >= 400:
                raise ValueError(f"Agent error: {resp.get('error')}")
            devices = (resp.get("body") or {}).get("devices", [])
            if devices:
                from app.core.db import SessionLocal
                with SessionLocal() as db:
                    for d in devices:
                        row = db.query(Printer).filter(
                            Printer.bambu_dev_id == d["dev_id"],
                            Printer.organization_id == org.id,
                        ).first()
                        if row and d.get("ip") and row.bambu_dev_ip != d["ip"]:
                            row.bambu_dev_ip = d["ip"]
                    db.commit()
            return devices
        except Exception as e:
            log.debug("Agent discover failed, falling back to local: %s", e)

    import json
    import socket

    BAMBU_PORT = 2021
    TIMEOUT = 3.0

    def _discover() -> list[dict]:
        import time
        results: dict[str, dict] = {}
        msg = json.dumps({"command": "get_version"}).encode()

        # Try both global broadcast and any subnet broadcasts we can derive
        targets = ["255.255.255.255"]
        try:
            import netifaces  # optional; skip if not installed
            for iface in netifaces.interfaces():
                addrs = netifaces.ifaddresses(iface).get(netifaces.AF_INET, [])
                for a in addrs:
                    if "broadcast" in a:
                        targets.append(a["broadcast"])
        except ImportError:
            pass

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", 0))
        sock.settimeout(0.2)  # short per-recv timeout; loop for full TIMEOUT
        try:
            for target in dict.fromkeys(targets):  # deduplicate
                try:
                    sock.sendto(msg, (target, BAMBU_PORT))
                except Exception:
                    pass
            deadline = time.monotonic() + TIMEOUT
            while time.monotonic() < deadline:
                try:
                    data, addr = sock.recvfrom(4096)
                    try:
                        payload = json.loads(data)
                    except Exception:
                        continue
                    dev_id = payload.get("dev_id") or payload.get("sn") or ""
                    if dev_id:
                        results[dev_id] = {
                            "dev_id": dev_id,
                            "ip": addr[0],
                            "name": payload.get("dev_name") or payload.get("name") or "",
                            "model": payload.get("dev_product_name") or payload.get("machine_type") or "",
                        }
                except socket.timeout:
                    continue
                except Exception:
                    continue
        finally:
            sock.close()
        return list(results.values())

    return await asyncio.to_thread(_discover)


@router.get("/limit")
def get_printer_limit(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> dict:
    from app.api.deps import printer_limit
    from app.models.organization import PLAN_LIMITS, PLAN_MAX_PRINTERS, EXTRA_PRINTER_PRICE_USD
    base  = PLAN_LIMITS[org.plan]["printers"]
    limit = printer_limit(org)
    count = db.query(Printer).filter(Printer.organization_id == org.id).count()
    return {
        "count": count,
        "limit": limit,
        "base": base,
        "extra_slots": org.extra_printer_slots or 0,
        "plan": org.plan,
        "max": PLAN_MAX_PRINTERS[org.plan],
        "extra_price_usd": EXTRA_PRINTER_PRICE_USD[org.plan],
    }


@router.get("/discover")
async def discover_printers(
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> dict:
    """Trigger agent LAN scan for Bambu + Moonraker printers not yet in the DB."""
    if not _tunnel.has_tunnel(org.id):
        raise HTTPException(status_code=503, detail="Agent not connected")

    existing_bambu_ids = {
        p.bambu_dev_id
        for p in db.query(Printer).filter(Printer.organization_id == org.id, Printer.bambu_dev_id.isnot(None)).all()
    }
    existing_moonraker_urls = {
        p.moonraker_url
        for p in db.query(Printer).filter(Printer.organization_id == org.id, Printer.moonraker_url.isnot(None)).all()
    }

    bambu_resp, moonraker_resp = await asyncio.gather(
        _tunnel.proxy_request(org.id, "DISCOVER_BAMBU", "", timeout=10.0),
        _tunnel.proxy_request(org.id, "DISCOVER_MOONRAKER", "", timeout=60.0),
        return_exceptions=True,
    )

    bambu_devices: list[dict] = []
    if isinstance(bambu_resp, dict):
        for d in (bambu_resp.get("body") or {}).get("devices", []):
            if d.get("dev_id") not in existing_bambu_ids:
                bambu_devices.append(d)

    moonraker_devices: list[dict] = []
    if isinstance(moonraker_resp, dict):
        for d in (moonraker_resp.get("body") or {}).get("devices", []):
            url = (d.get("url") or "").rstrip("/")
            if url not in existing_moonraker_urls:
                moonraker_devices.append(d)

    return {"bambu": bambu_devices, "moonraker": moonraker_devices}


@router.get("/{printer_id}", response_model=PrinterOut)
async def get_printer(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> PrinterOut:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    groups_by_id = {g.id: g.name for g in db.query(PrinterGroup).filter(PrinterGroup.organization_id == org.id).all()}
    live: dict | None = None
    if row.moonraker_url:
        try:
            if _tunnel.has_tunnel(org.id):
                live = await asyncio.wait_for(
                    _tunnel.get_moonraker_status(org.id, row.moonraker_url),
                    timeout=1.2,
                )
            else:
                live = await asyncio.wait_for(
                    asyncio.to_thread(moonraker.get_live_status, row.moonraker_url),
                    timeout=1.8,
                )
        except Exception as e:
            log.debug("Printer detail live status timed out printer=%s: %s", row.id, e)
            live = moonraker.get_cached_live_status(row.moonraker_url) or {"state": "offline"}
    from app.models.printer_slot import PrinterSlot as _PrinterSlot
    slot_rows = db.query(_PrinterSlot).filter(_PrinterSlot.printer_id == row.id).all()
    pslots = [{
        "slot_index": s.slot_index,
        "filament_id": s.filament_id,
        "material": s.material,
        "color": s.color,
        "hex_color": s.hex_color,
        "brand": s.brand,
        "grams_at_load": s.grams_at_load,
        "state": s.state.value,
        "unit_index": s.unit_index,
        "is_external": s.is_external,
    } for s in slot_rows]

    return _to_dto(row, db, groups_by_id, prefetched_live=live, prefetched_slots=pslots)


@router.get("/{printer_id}/webcam/snapshot")
async def webcam_snapshot(
    printer_id: int,
    token: str | None = None,
    db: Session = Depends(get_db),
) -> Response:
    """Proxy a single webcam snapshot from Moonraker — bypasses browser Private Network Access.

    Accepts token as query param (for <img> tags that can't set headers).
    """
    from app.core.security import decode_token
    payload = decode_token(token or "")
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.get(User, int(payload.get("sub", 0)))
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid user")
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == user.organization_id).first()
    if not row or not row.moonraker_url:
        raise HTTPException(status_code=404, detail="No Moonraker URL")
    base = moonraker._api_base(row.moonraker_url)  # noqa: SLF001
    org_id = user.organization_id

    # Resolve snapshot URL — prefer Moonraker webcam config, fallback to crowsnest default
    async def _get_snapshot_url() -> str:
        try:
            if _tunnel.has_tunnel(org_id):
                resp = await _tunnel.proxy_request(org_id, "GET", f"{base}/server/webcams/list")
                webcams = resp.get("body", {}).get("result", {}).get("webcams", [])
            else:
                webcams = await asyncio.to_thread(moonraker.get_webcams, row.moonraker_url)
        except Exception:
            webcams = []
        if webcams:
            url = webcams[0].get("snapshot_url", "")
            return url if url.startswith("http") else base + url
        return f"{base}/webcam/?action=snapshot"

    snapshot_url = await _get_snapshot_url()

    # Fetch snapshot — through tunnel if agent connected, direct otherwise
    try:
        if _tunnel.has_tunnel(org_id):
            result = await _tunnel.proxy_request(org_id, "GET", snapshot_url, timeout=8.0)
            if result.get("status", 0) >= 400:
                raise HTTPException(status_code=502, detail=f"Webcam unavailable via tunnel: {result.get('status')}")
            if result.get("binary"):
                import base64 as _b64
                content = _b64.b64decode(result["binary"])
                media_type = result.get("content_type", "image/jpeg")
                return Response(content=content, media_type=media_type, headers={"Cache-Control": "no-store"})
        resp = await asyncio.to_thread(lambda: _requests.get(snapshot_url, timeout=5))
        resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Webcam unavailable: {exc}") from exc
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{printer_id}/camera/snapshot")
async def camera_snapshot(
    printer_id: int,
    token: str | None = None,
    db: Session = Depends(get_db),
) -> Response:
    """Return one camera frame for Telegram/alert snapshots.

    Bambu frames are captured through the farm agent tunnel. Moonraker falls
    back to the existing webcam snapshot proxy behavior.
    """
    from app.core.security import decode_token

    payload = decode_token(token or "")
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.get(User, int(payload.get("sub", 0)))
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid user")
    row = db.query(Printer).filter(
        Printer.id == printer_id,
        Printer.organization_id == user.organization_id,
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")

    org_id = user.organization_id
    if row.kind == PrinterKind.bambu:
        if not row.bambu_dev_ip or not row.bambu_access_code:
            raise HTTPException(status_code=404, detail="Camera not available")
        if not _tunnel.has_tunnel(org_id):
            raise HTTPException(status_code=502, detail="Agent tunnel unavailable")
        try:
            async for chunk in _tunnel.bambu_camera_stream(
                org_id,
                row.bambu_dev_ip,
                row.bambu_access_code,
                chunk_timeout=10.0,
            ):
                jpeg = _jpeg_from_mjpeg_chunk(chunk)
                if jpeg:
                    return Response(
                        content=jpeg,
                        media_type="image/jpeg",
                        headers={"Cache-Control": "no-store"},
                    )
            raise HTTPException(status_code=502, detail="No camera frame")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Camera unavailable: {exc}") from exc

    if row.moonraker_url:
        base = moonraker._api_base(row.moonraker_url)  # noqa: SLF001
        try:
            webcams = []
            if _tunnel.has_tunnel(org_id):
                try:
                    resp = await _tunnel.proxy_request(org_id, "GET", f"{base}/server/webcams/list", timeout=8.0)
                    webcams = resp.get("body", {}).get("result", {}).get("webcams", [])
                except Exception:
                    webcams = []
                snapshot_url = ""
                if webcams:
                    snapshot_url = webcams[0].get("snapshot_url", "") or ""
                    if snapshot_url and not snapshot_url.startswith("http"):
                        snapshot_url = f"{base}{snapshot_url if snapshot_url.startswith('/') else '/' + snapshot_url}"
                if not snapshot_url:
                    snapshot_url = f"{base}/webcam/?action=snapshot"
                result = await _tunnel.proxy_request(org_id, "GET", snapshot_url, timeout=8.0)
                if result.get("binary"):
                    content = base64.b64decode(result["binary"])
                    return Response(
                        content=content,
                        media_type=result.get("content_type", "image/jpeg"),
                        headers={"Cache-Control": "no-store"},
                    )

            resp = await asyncio.to_thread(lambda: _requests.get(f"{base}/webcam/?action=snapshot", timeout=5))
            resp.raise_for_status()
            return Response(
                content=resp.content,
                media_type=resp.headers.get("content-type", "image/jpeg"),
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Webcam unavailable: {exc}") from exc

    raise HTTPException(status_code=404, detail="Camera not available")


@router.get("/{printer_id}/camera/stream")
async def camera_stream(
    printer_id: int,
    token: str | None = None,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Stream Bambu Lab camera as MJPEG.

    Uses go2rtc sidecar when GO2RTC_URL is configured (recommended).
    Falls back to FFmpeg if available.
    Accepts token as query param (for <img> tags that can't set headers).
    """
    from app.core.security import decode_token
    from app.services import go2rtc

    payload = decode_token(token or "")
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.get(User, int(payload.get("sub", 0)))
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid user")
    row = db.query(Printer).filter(
        Printer.id == printer_id,
        Printer.organization_id == user.organization_id,
    ).first()
    if not row or row.kind != PrinterKind.bambu or not row.bambu_dev_ip:
        raise HTTPException(status_code=404, detail="Camera not available: set LAN IP in printer settings")

    org_id = user.organization_id

    # go2rtc stream URL — uses bambu:// for A1/P1 (port 6000), rtsps:// for X1 (port 322)
    go2rtc._stream_url(row.bambu_access_code, row.bambu_dev_ip, row.bambu_model or "")
    go2rtc.stream_name(row.bambu_dev_id)
    # go2rtc MJPEG endpoint — accessed locally at localhost:1984 from farm PC

    # ── Tunnel path: native Bambu binary protocol via agent ───────────────────
    # Agent on farm PC connects directly to printer:6000 using the documented
    # binary TLS protocol (github.com/Doridian/OpenBambuAPI/blob/main/video.md)
    if _tunnel.has_tunnel(org_id):
        async def _bambu_cam_stream():
            try:
                async for chunk in _tunnel.bambu_camera_stream(
                    org_id, row.bambu_dev_ip, row.bambu_access_code
                ):
                    yield chunk
            except Exception as exc:
                log.warning("Bambu camera tunnel error printer %s: %s", printer_id, exc)

        return StreamingResponse(
            _bambu_cam_stream(),
            media_type="multipart/x-mixed-replace; boundary=frame",
            headers={"Cache-Control": "no-store"},
        )

    # ── go2rtc path (local, when backend is on the same LAN as printers) ──────
    if go2rtc.is_available():
        await go2rtc.register_stream(row.bambu_dev_id, row.bambu_access_code, row.bambu_dev_ip, row.bambu_model or "")

        async def _go2rtc_proxy():
            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream("GET", go2rtc.mjpeg_url(row.bambu_dev_id)) as resp:
                        async for chunk in resp.aiter_bytes(32768):
                            yield chunk
            except Exception as exc:
                log.warning("go2rtc stream error printer %s: %s", printer_id, exc)

        return StreamingResponse(
            _go2rtc_proxy(),
            media_type="multipart/x-mixed-replace; boundary=frame",
            headers={"Cache-Control": "no-store"},
        )

    # ── FFmpeg fallback ────────────────────────────────────────────────────────
    import shutil
    if not shutil.which("ffmpeg"):
        raise HTTPException(
            status_code=503,
            detail="Camera unavailable: install go2rtc (recommended) or ffmpeg on the server.",
        )

    rtsps_url = f"rtsps://bblp:{row.bambu_access_code}@{row.bambu_dev_ip}:322/streaming/live/1"
    cmd = [
        "ffmpeg", "-loglevel", "quiet",
        "-rtsp_transport", "tcp", "-tls_verify", "0",
        "-i", rtsps_url,
        "-vf", "fps=5", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3",
        "pipe:1",
    ]

    async def _ffmpeg_generate():
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        buf = b""
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                while True:
                    start = buf.find(b"\xff\xd8")
                    if start < 0:
                        break
                    end = buf.find(b"\xff\xd9", start + 2)
                    if end < 0:
                        break
                    frame = buf[start:end + 2]
                    buf = buf[end + 2:]
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
        finally:
            proc.kill()
            await proc.wait()

    return StreamingResponse(
        _ffmpeg_generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store"},
    )


@router.get("", response_model=list[PrinterOut])
async def list_printers(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrinterOut]:
    bambu_devices = await asyncio.to_thread(bambu.list_devices, org.id)
    _sync_bambu_rows(db, bambu_devices, org.id)

    groups_by_id = {g.id: g.name for g in db.query(PrinterGroup).filter(PrinterGroup.organization_id == org.id).all()}
    groups_order = {g.id: g.sort_order for g in db.query(PrinterGroup).filter(PrinterGroup.organization_id == org.id).all()}

    rows = (
        db.query(Printer)
        .filter(Printer.is_active.is_(True), Printer.organization_id == org.id)
        .all()
    )
    rows.sort(key=lambda p: (
        p.group_id is None,
        groups_order.get(p.group_id, 0) if p.group_id is not None else 0,
        p.sort_order,
        _natural_key(p.name),
    ))

    # Fetch all Moonraker statuses in parallel — via tunnel if available, else direct
    moonraker_rows = [r for r in rows if r.moonraker_url]
    if moonraker_rows:
        if _tunnel.has_tunnel(org.id):
            fetchers = [_tunnel.get_moonraker_status(org.id, r.moonraker_url) for r in moonraker_rows]
        else:
            fetchers = [asyncio.to_thread(moonraker.get_live_status, r.moonraker_url) for r in moonraker_rows]
        results = await asyncio.gather(*fetchers, return_exceptions=True)
        live_by_url: dict[str, dict] = {}
        for r, res in zip(moonraker_rows, results):
            live_by_url[r.moonraker_url] = res if isinstance(res, dict) else {"state": "offline"}
    else:
        live_by_url = {}

    # Batch-fetch PrinterSlot rows for all printers in one query
    from app.models.printer_slot import PrinterSlot as _PrinterSlot
    all_ids = [r.id for r in rows]
    slots_by_printer: dict[int, list[dict]] = {}
    if all_ids:
        slot_rows = db.query(_PrinterSlot).filter(_PrinterSlot.printer_id.in_(all_ids)).all()
        for s in slot_rows:
            slots_by_printer.setdefault(s.printer_id, []).append({
                "slot_index": s.slot_index,
                "filament_id": s.filament_id,
                "material": s.material,
                "color": s.color,
                "hex_color": s.hex_color,
                "brand": s.brand,
                "grams_at_load": s.grams_at_load,
                "state": s.state.value,
                "unit_index": s.unit_index,
                "is_external": s.is_external,
            })

    out: list[PrinterOut] = []
    for row in rows:
        prefetched = live_by_url.get(row.moonraker_url) if row.moonraker_url else None
        pslots = slots_by_printer.get(row.id) or None
        out.append(_to_dto(row, db, groups_by_id, prefetched_live=prefetched, prefetched_slots=pslots))
    return out


@router.get("/bambu/discovered")
async def list_bambu_discovered(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> list[dict]:
    """Bambu Cloud devices not yet claimed into this org."""
    devices = await asyncio.to_thread(lambda: bambu.list_devices(org.id, force=True))
    if not devices:
        return []
    claimed_ids = {
        p.bambu_dev_id
        for p in db.query(Printer).filter(
            Printer.organization_id == org.id,
            Printer.bambu_dev_id.isnot(None),
        )
    }
    return [
        {
            "dev_id": d["dev_id"],
            "name": d["name"],
            "model": d.get("dev_product_name") or d.get("dev_model_name") or "",
        }
        for d in devices
        if d["dev_id"] not in claimed_ids
    ]


@router.post("/bambu/claim", response_model=PrinterOut, status_code=status.HTTP_201_CREATED)
async def claim_bambu_printer(
    payload: dict,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> PrinterOut:
    """Explicitly add a discovered Bambu device to this org (checks plan limit)."""
    from app.api.deps import printer_limit
    dev_id = payload.get("dev_id", "").strip()
    if not dev_id:
        raise HTTPException(status_code=400, detail="dev_id is required")

    already = db.query(Printer).filter(
        Printer.bambu_dev_id == dev_id,
        Printer.organization_id == org.id,
    ).first()
    if already:
        raise HTTPException(status_code=409, detail="Printer already claimed")

    active_count = db.query(Printer).filter(
        Printer.organization_id == org.id,
        Printer.is_active.is_(True),
    ).count()
    limit = printer_limit(org)
    if active_count >= limit:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Printer limit reached ({limit}). Buy extra slots or upgrade your plan.",
        )

    devices = await asyncio.to_thread(lambda: bambu.list_devices(org.id, force=True))
    device = next((d for d in devices if d["dev_id"] == dev_id), None)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found in Bambu Cloud account")

    bmodel = device.get("dev_product_name") or device.get("dev_model_name") or ""
    bvol = _bambu_build_volume(bmodel)
    fw = await asyncio.to_thread(bambu.get_device_firmware_version, org.id, dev_id)
    row = Printer(
        organization_id=org.id,
        name=device["name"],
        kind=PrinterKind.bambu,
        bambu_dev_id=dev_id,
        bambu_access_code=device.get("dev_access_code", ""),
        bambu_model=bmodel,
        firmware_version=fw,
        build_x=bvol[0] if bvol else None,
        build_y=bvol[1] if bvol else None,
        build_z=bvol[2] if bvol else None,
        nozzle_diameter=_default_nozzle(PrinterKind.bambu, bmodel),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    bambu.subscribe_device(row.bambu_dev_id, org.id)
    return _to_dto(row, db)


@router.post("/moonraker/check")
async def check_moonraker_connection(
    payload: dict,
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Verify a Moonraker URL is reachable and return firmware info.

    Works via the agent tunnel if connected, direct HTTP otherwise.
    Returns {"ok": true, "firmware_version": ..., "hostname": ..., "features": {...}}
    or {"ok": false, "error": "..."}.
    """
    from app.services.firmware_matrix import get_features as _fw_features
    from app.services.moonraker import _api_base

    url = (payload.get("url") or "").strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=400, detail="url required")

    base = _api_base(url)
    try:
        if _tunnel.has_tunnel(org.id):
            resp = await _tunnel.proxy_request(org.id, "GET", f"{base}/printer/info", timeout=8.0)
            if resp.get("status", 0) >= 400:
                return {"ok": False, "error": f"HTTP {resp.get('status')}"}
            info = (resp.get("body") or {}).get("result", {})
        else:
            def _fetch() -> dict:
                import requests as _req
                return _req.get(f"{base}/printer/info", timeout=5).json().get("result", {})
            info = await asyncio.to_thread(_fetch)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    firmware_version = info.get("software_version") or None
    hostname = info.get("hostname") or None
    return {
        "ok": True,
        "firmware_version": firmware_version,
        "hostname": hostname,
        "features": _fw_features(firmware_version),
    }


@router.get("/moonraker/discovered")
async def list_moonraker_discovered(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> list[dict]:
    """Moonraker URLs discovered on LAN via agent tunnel, not yet in DB."""
    if not _tunnel.has_tunnel(org.id):
        return []

    existing_urls = {
        p.moonraker_url.rstrip("/")
        for p in db.query(Printer).filter(
            Printer.organization_id == org.id,
            Printer.moonraker_url.isnot(None),
        )
        if p.moonraker_url
    }

    try:
        resp = await _tunnel.proxy_request(org.id, "DISCOVER_MOONRAKER", "", timeout=60.0)
        if resp.get("error") or resp.get("status", 0) >= 400:
            return []
        devices = (resp.get("body") or {}).get("devices", [])
    except Exception:
        return []

    return [
        {
            "url": d["url"],
            "name": d.get("name") or d.get("hostname") or "Klipper Printer",
        }
        for d in devices
        if d.get("url") and d["url"].rstrip("/") not in existing_urls
    ]


@router.post("/moonraker/claim", response_model=PrinterOut, status_code=status.HTTP_201_CREATED)
async def claim_moonraker_printer(
    payload: dict,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> PrinterOut:
    """Add a discovered Moonraker/Klipper printer to this org (checks plan limit)."""
    from app.api.deps import printer_limit
    url = (payload.get("url") or "").strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    already = db.query(Printer).filter(
        Printer.moonraker_url == url,
        Printer.organization_id == org.id,
    ).first()
    if already:
        raise HTTPException(status_code=409, detail="Printer already added")

    active_count = db.query(Printer).filter(
        Printer.organization_id == org.id,
        Printer.is_active.is_(True),
    ).count()
    limit = printer_limit(org)
    if active_count >= limit:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Printer limit reached ({limit}). Buy extra slots or upgrade your plan.",
        )

    name = (payload.get("name") or "Klipper Printer").strip()
    fw = (payload.get("firmware_version") or "").strip() or None
    kind_raw = payload.get("kind") or "other"
    try:
        kind = PrinterKind(kind_raw)
    except ValueError:
        kind = PrinterKind.other
    row = Printer(
        organization_id=org.id,
        name=name,
        kind=kind,
        moonraker_url=url,
        firmware_version=fw,
        nozzle_diameter=_default_nozzle(kind, None),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_dto(row, db)


@router.post("", response_model=PrinterOut, status_code=status.HTTP_201_CREATED)
def create_printer(
    payload: PrinterCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> PrinterOut:
    from app.api.deps import printer_limit
    current_count = db.query(Printer).filter(Printer.organization_id == org.id).count()
    limit = printer_limit(org)
    if current_count >= limit:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Printer limit reached ({limit}). Buy extra slots or upgrade your plan.",
        )
    bvol = _bambu_build_volume(payload.bambu_model) if payload.kind == PrinterKind.bambu else None
    auto_nozzle = _default_nozzle(payload.kind, payload.bambu_model)
    row = Printer(
        organization_id=org.id,
        name=payload.name,
        kind=payload.kind,
        moonraker_url=payload.moonraker_url,
        bambu_dev_id=payload.bambu_dev_id,
        bambu_access_code=payload.bambu_access_code,
        bambu_dev_ip=payload.bambu_dev_ip,
        bambu_model=payload.bambu_model,
        bambu_lan_mode=payload.bambu_lan_mode,
        build_x=payload.build_x if payload.build_x is not None else (bvol[0] if bvol else None),
        build_y=payload.build_y if payload.build_y is not None else (bvol[1] if bvol else None),
        build_z=payload.build_z if payload.build_z is not None else (bvol[2] if bvol else None),
        nozzle_diameter=payload.nozzle_diameter if payload.nozzle_diameter is not None else auto_nozzle,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        if row.bambu_lan_mode and row.bambu_dev_ip and row.bambu_access_code:
            bambu.start_lan_mqtt(row.bambu_dev_id, row.bambu_dev_ip, row.bambu_access_code)
        else:
            bambu.subscribe_device(row.bambu_dev_id, org.id)
    return _to_dto(row, db)


@router.patch("/{printer_id}", response_model=PrinterOut)
def update_printer(
    printer_id: int,
    payload: PrinterUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> PrinterOut:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if payload.name is not None:
        row.name = payload.name
    if payload.is_active is not None:
        row.is_active = payload.is_active
    if payload.is_out_of_order is not None:
        row.is_out_of_order = payload.is_out_of_order
    if payload.moonraker_url is not None:
        row.moonraker_url = payload.moonraker_url.strip() or None
    if payload.bambu_dev_id is not None:
        row.bambu_dev_id = payload.bambu_dev_id.strip() or None
    if payload.bambu_access_code is not None:
        row.bambu_access_code = payload.bambu_access_code.strip() or None
    if payload.bambu_dev_ip is not None:
        row.bambu_dev_ip = payload.bambu_dev_ip.strip() or None
    if payload.bambu_model is not None:
        row.bambu_model = payload.bambu_model.strip() or None
        # Auto-fill build volume when model name is set and no explicit override given
        if row.kind == PrinterKind.bambu and payload.build_x is None:
            bvol = _bambu_build_volume(row.bambu_model)
            if bvol:
                row.build_x, row.build_y, row.build_z = bvol
    if payload.bambu_lan_mode is not None:
        row.bambu_lan_mode = payload.bambu_lan_mode
    if payload.build_x is not None:
        row.build_x = payload.build_x
    if payload.build_y is not None:
        row.build_y = payload.build_y
    if payload.build_z is not None:
        row.build_z = payload.build_z
    if payload.nozzle_diameter is not None:
        row.nozzle_diameter = payload.nozzle_diameter
    if payload.bed_type is not None:
        row.bed_type = payload.bed_type.strip() or None
    db.commit()
    db.refresh(row)

    # Restart LAN MQTT if relevant fields changed on a Bambu printer
    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        if row.bambu_lan_mode and row.bambu_dev_ip and row.bambu_access_code:
            bambu.start_lan_mqtt(row.bambu_dev_id, row.bambu_dev_ip, row.bambu_access_code)
        else:
            bambu.stop_lan_mqtt(row.bambu_dev_id)

    return _to_dto(row, db)


@router.post("/{printer_id}/group", response_model=PrinterOut)
def assign_group(
    printer_id: int,
    payload: PrinterGroupAssign,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if payload.group_id is not None:
        group = db.query(PrinterGroup).filter(PrinterGroup.id == payload.group_id, PrinterGroup.organization_id == org.id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Group not found")
    row.group_id = payload.group_id
    db.commit()
    db.refresh(row)
    return _to_dto(row, db)


@router.put("/{printer_id}/loaded-filaments", response_model=PrinterOut)
def set_loaded_filaments(
    printer_id: int,
    slots: list[FilamentSlot],
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    """Replace the full list of filament slots loaded in the printer."""
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    row.loaded_filaments = [s.model_dump() for s in slots]
    db.commit()
    db.refresh(row)
    return _to_dto(row, db)


@router.post("/{printer_id}/manual", response_model=PrinterOut)
def set_manual_state(
    printer_id: int,
    payload: PrinterManualUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if payload.status is not None:
        row.manual_status = payload.status
    if payload.job is not None:
        row.manual_job = payload.job
    if payload.eta_minutes is not None:
        row.manual_eta_minutes = payload.eta_minutes
    row.manual_updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _to_dto(row, db)


@router.delete("/{printer_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_printer(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> None:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    # Cascade: drop plan entries pointing to this printer
    db.query(PlanEntry).filter(PlanEntry.printer_id == printer_id).delete()
    db.delete(row)
    db.commit()


@router.delete("", status_code=status.HTTP_200_OK)
def bulk_delete_printers(
    kind: str | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Delete all printers for this org, optionally filtered by kind."""
    q = db.query(Printer).filter(Printer.organization_id == org.id)
    if kind:
        q = q.filter(Printer.kind == kind)
    rows = q.all()
    ids = [r.id for r in rows]
    if ids:
        db.query(PlanEntry).filter(PlanEntry.printer_id.in_(ids)).delete(synchronize_session=False)
        db.query(Printer).filter(Printer.id.in_(ids)).delete(synchronize_session=False)
        db.commit()
    return {"deleted": len(ids)}


@router.post("/reorder", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def reorder_printers(
    items: list[PrinterReorderItem],
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    """Bulk-update sort_order for a list of printers."""
    for item in items:
        row = db.query(Printer).filter(Printer.id == item.id, Printer.organization_id == org.id).first()
        if row:
            row.sort_order = item.sort_order
    db.commit()


@router.post("/sync", response_model=list[PrinterOut])
async def force_sync(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> list[PrinterOut]:
    return await list_printers(db=db, org=org)


# ── Moonraker print control ─────────────────────────────────────────────────


_MR_ACTION_PATH = {
    "pause":  "/printer/print/pause",
    "resume": "/printer/print/resume",
    "cancel": "/printer/print/cancel",
}


async def _moonraker_action(
    printer_id: int, action_name: str, action_fn, db: Session, org_id: int
) -> dict:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if not row.moonraker_url:
        raise HTTPException(status_code=400, detail="У принтера не вказано Moonraker URL")
    try:
        if _tunnel.has_tunnel(org_id) and action_name in _MR_ACTION_PATH:
            await _tunnel.moonraker_action(org_id, row.moonraker_url, _MR_ACTION_PATH[action_name])
        else:
            await asyncio.to_thread(action_fn, row.moonraker_url)
    except (moonraker.MoonrakerError, RuntimeError) as e:
        raise HTTPException(status_code=502, detail=str(e))
    moonraker.invalidate_status(row.moonraker_url)
    return {"ok": True, "action": action_name}


@router.post("/{printer_id}/pause")
async def pause_print(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "pause", moonraker.pause_print, db, org.id)


@router.post("/{printer_id}/resume")
async def resume_print(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "resume", moonraker.resume_print, db, org.id)


@router.post("/{printer_id}/cancel")
async def cancel_print(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "cancel", moonraker.cancel_print, db, org.id)


# ── Unified print controls (dispatches to Moonraker or Bambu) ────────────────


@router.patch("/{printer_id}/autoprint", response_model=PrinterOut)
def update_autoprint(
    printer_id: int,
    payload: AutoPrintSettings,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    row = _require_printer(printer_id, db, org.id)
    if payload.enabled:
        from app.services.autoprint import is_a1_mini

        if row.kind != PrinterKind.bambu or not is_a1_mini(row.bambu_model, row.bambu_dev_id):
            raise HTTPException(status_code=400, detail="AutoPrint PlateCycler підтримує лише Bambu A1 Mini")
        # Cloud-mode printers are fine: upload goes via agent FTPS, start via
        # cloud MQTT project_file. IP + Access Code are still needed for FTPS.
        if not row.bambu_dev_ip or not row.bambu_access_code:
            raise HTTPException(
                status_code=400,
                detail="Для AutoPrint потрібні IP адреса та Access Code принтера (FTPS-завантаження через monofarm-agent)",
            )
        if not 1 <= payload.plates_loaded <= 10:
            raise HTTPException(status_code=422, detail="Кількість пластин має бути від 1 до 10")
        if not 20 <= payload.cooldown_temp_c <= 80:
            raise HTTPException(status_code=422, detail="Cooling temperature має бути від 20 до 80°C")
        if not 0 <= payload.delay_seconds <= 3600:
            raise HTTPException(status_code=422, detail="Delay має бути від 0 до 3600 секунд")
        row.autoprint_mode = "platecycler"
        row.autoprint_plates_remaining = payload.plates_loaded
        row.autoprint_cooldown_temp_c = payload.cooldown_temp_c
        row.autoprint_delay_seconds = payload.delay_seconds
        row.autoprint_eject_last_plate = payload.eject_last_plate
        row.autoprint_error = None
    else:
        row.autoprint_mode = "off"
        row.autoprint_error = None
    db.commit()
    db.refresh(row)
    if row.autoprint_mode == "platecycler":
        from app.services.autoprint import start_next_for_printer

        background_tasks.add_task(start_next_for_printer, row.id)
    return _to_dto(row, db)


def _require_printer(printer_id: int, db: Session, org_id: int) -> Printer:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    return row


# pause/resume/stop for LAN-mode printers go through the agent's LAN MQTT:
# post-Jan-2025 firmware ignores unsigned print.* commands over cloud MQTT
# (X.509), while LAN + Developer Mode accepts them on every firmware.
_BAMBU_LAN_COMMANDS = {
    "pause": "pause",
    "resume": "resume",
    "cancel": "stop",
    "clear-error": "clean_print_error",
}


async def _dispatch(
    printer_id: int,
    action: str,
    mr_fn,
    db: Session,
    org: Organization,
    bambu_fn=None,
    optimistic_state: str | None = None,
) -> dict:
    """Route to Moonraker or Bambu based on printer kind."""
    import time as _time
    row = _require_printer(printer_id, db, org.id)
    if row.kind == PrinterKind.bambu and row.bambu_dev_id and bambu_fn:
        lan_via_agent = (
            row.bambu_lan_mode
            and row.bambu_dev_ip
            and row.bambu_access_code
            and action in _BAMBU_LAN_COMMANDS
            and _tunnel.has_tunnel(org.id)
        )
        try:
            if lan_via_agent:
                payload = {"print": {
                    "command": _BAMBU_LAN_COMMANDS[action],
                    "param": "",
                    "sequence_id": bambu._next_seq(),  # noqa: SLF001
                }}
                await _tunnel.send_bambu_mqtt(
                    org.id, row.bambu_dev_id, row.bambu_dev_ip,
                    row.bambu_access_code.strip(), payload,
                )
            else:
                await asyncio.to_thread(bambu_fn, row.bambu_dev_id)
        except (bambu.BambuError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=str(e))
        # Optimistically set transitional state — MQTT will correct it within seconds
        if optimistic_state and row.bambu_dev_id in bambu._state_cache:  # noqa: SLF001
            bambu._state_cache[row.bambu_dev_id]["state"] = optimistic_state  # noqa: SLF001
            bambu._state_cache[row.bambu_dev_id]["ts"] = _time.monotonic()  # noqa: SLF001
    elif row.moonraker_url:
        try:
            if _tunnel.has_tunnel(org.id) and action in _MR_ACTION_PATH:
                await _tunnel.moonraker_action(org.id, row.moonraker_url, _MR_ACTION_PATH[action])
            else:
                await asyncio.to_thread(mr_fn, row.moonraker_url)
        except (moonraker.MoonrakerError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=str(e))
        moonraker.invalidate_status(row.moonraker_url)
    else:
        raise HTTPException(status_code=400, detail="Принтер не підтримує цю дію")
    return {"ok": True, "action": action}


@router.post("/{printer_id}/print/pause")
async def print_pause(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "pause",
        moonraker.pause_print,
        db, org,
        bambu_fn=bambu.pause_print,
        optimistic_state="pausing",
    )


@router.post("/{printer_id}/print/resume")
async def print_resume(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "resume",
        moonraker.resume_print,
        db, org,
        bambu_fn=bambu.resume_print,
        optimistic_state="resuming",
    )


@router.post("/{printer_id}/print/cancel")
async def print_cancel(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "cancel",
        moonraker.cancel_print,
        db, org,
        bambu_fn=bambu.stop_print,
        optimistic_state="cancelling",
    )


@router.post("/{printer_id}/print/clear-bed")
async def print_clear_bed(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Mark bed cleared — operator confirmed print was removed from bed."""
    row = _require_printer(printer_id, db, org.id)

    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        from app.services import bambu
        live = bambu.get_cached_state(row.bambu_dev_id)
        bambu.mark_bed_cleared(row.bambu_dev_id, live.get("filename"))

    elif row.moonraker_url:
        # Home the printer — typical Klipper post-print sequence
        try:
            await asyncio.to_thread(moonraker.send_gcode, row.moonraker_url, "G28")
        except Exception:
            pass
        moonraker.invalidate_status(row.moonraker_url)

    else:
        row.manual_status = "idle"
        row.manual_job = None
        db.commit()

    return {"ok": True, "action": "clear_bed"}


@router.post("/{printer_id}/print/clear-error")
async def print_clear_error(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Acknowledge and clear an error state."""
    row = _require_printer(printer_id, db, org.id)

    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        from app.services import bambu
        payload = {"print": {
            "command": _BAMBU_LAN_COMMANDS["clear-error"],
            "param": "",
            "sequence_id": bambu._next_seq(),  # noqa: SLF001
        }}
        try:
            if (
                row.bambu_lan_mode
                and row.bambu_dev_ip
                and row.bambu_access_code
                and _tunnel.has_tunnel(org.id)
            ):
                await _tunnel.send_bambu_mqtt(
                    org.id,
                    row.bambu_dev_id,
                    row.bambu_dev_ip,
                    row.bambu_access_code.strip(),
                    payload,
                )
            else:
                await asyncio.to_thread(bambu.clear_print_error, row.bambu_dev_id)
        except (bambu.BambuError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=str(e))
        import time as _time
        bambu._state_cache[row.bambu_dev_id] = {"ts": _time.monotonic(), "state": "idle"}

    elif row.moonraker_url:
        try:
            await asyncio.to_thread(moonraker.send_gcode, row.moonraker_url, "FIRMWARE_RESTART")
        except Exception:
            pass
        moonraker.invalidate_status(row.moonraker_url)

    else:
        row.manual_status = "idle"
        db.commit()

    return {"ok": True, "action": "clear_error"}


@router.post("/{printer_id}/print/skip-object")
async def print_skip_object(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Skip the currently-printing object via EXCLUDE_OBJECT_CURRENT gcode.

    Works on any Klipper printer with [exclude_object] enabled in printer.cfg.
    SimplyPrint: sends gcode via the SP API (printer must be Klipper-based).
    Moonraker: calls the /printer/gcode/script endpoint directly.
    """
    row = _require_printer(printer_id, db, org.id)
    if row.moonraker_url:
        try:
            await asyncio.to_thread(moonraker.skip_object, row.moonraker_url)
        except moonraker.MoonrakerError as e:
            raise HTTPException(status_code=502, detail=str(e))
        moonraker.invalidate_status(row.moonraker_url)
        return {"ok": True, "action": "skip_object"}
    raise HTTPException(status_code=400, detail="Принтер не підтримує цю дію")


class GcodePayload(BaseModel):
    script: str


@router.post("/{printer_id}/gcode")
async def send_gcode(
    printer_id: int,
    payload: GcodePayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Send raw G-code to a Moonraker or Bambu printer."""
    row = _require_printer(printer_id, db, org.id)
    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        try:
            await asyncio.to_thread(bambu.send_gcode, row.bambu_dev_id, payload.script)
        except bambu.BambuError as e:
            raise HTTPException(status_code=502, detail=str(e))
        return {"ok": True}
    if row.moonraker_url:
        try:
            if _tunnel.has_tunnel(org.id):
                await _tunnel.moonraker_action(org.id, row.moonraker_url, "/printer/gcode/script", {"script": payload.script})
            else:
                await asyncio.to_thread(moonraker.send_gcode, row.moonraker_url, payload.script)
        except (moonraker.MoonrakerError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=str(e))
        return {"ok": True}
    raise HTTPException(status_code=400, detail="G-code не підтримується для цього принтера")


class SpeedProfilePayload(BaseModel):
    profile: int  # 1=Silent 2=Standard 3=Sport 4=Ludicrous


@router.post("/{printer_id}/speed-profile")
async def set_speed_profile(
    printer_id: int,
    payload: SpeedProfilePayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Set Bambu speed profile (1-4)."""
    row = _require_printer(printer_id, db, org.id)
    if row.kind != PrinterKind.bambu or not row.bambu_dev_id:
        raise HTTPException(status_code=400, detail="Тільки для Bambu принтерів")
    try:
        await asyncio.to_thread(bambu.set_speed_profile, row.bambu_dev_id, payload.profile)
    except bambu.BambuError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}
