"""OctoPrint-compatible API shim.

Allows OrcaSlicer (and any other OctoPrint-aware slicer) to upload gcode files
directly to this server. Configure in OrcaSlicer:
  Host Type:  OctoPrint
  Hostname:   https://your-domain.com   (or http://localhost:8000)
  API Key:    <your JWT token from this app>

Implemented endpoints (minimal subset OrcaSlicer requires):
  GET  /api/version       — version handshake / connection test
  GET  /api/printer       — printer state (always "Operational" for connection test)
  POST /api/files/local   — upload a gcode file → stored in central gcode storage
"""
from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.security import decode_token
from app.models.gcode_file import GcodeFile
from app.models.user import User
from app.services import storage as storage_svc
from app.services.gcode_meta import parse_gcode
from app.services.storage import LOCAL_DIR as GCODES_DIR

from fastapi import Depends

ALLOWED_EXTS = {".gcode", ".gco", ".g", ".3mf", ".bgcode"}
MAX_FILE_BYTES = 500 * 1024 * 1024

router = APIRouter(prefix="/api", tags=["octoprint"])


# ── Auth helper ───────────────────────────────────────────────────────────────

def _resolve_user(
    x_api_key: str | None,
    db: Session,
) -> User:
    """Accept OctoPrint-style X-Api-Key: scoped ApiKey (preferred) or JWT (legacy)."""
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Missing API key")

    # Try scoped ApiKey first (mf_… prefix or any non-JWT value)
    if not x_api_key.startswith("eyJ"):
        from app.api.api_keys import resolve_api_key
        user = resolve_api_key(x_api_key, db)
        if user and user.is_active:
            return user
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid or expired API key")

    # Legacy path: raw JWT token
    payload = decode_token(x_api_key)
    if not payload:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")
    user = db.get(User, int(user_id))
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User inactive")
    return user


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/version")
def octo_version() -> dict:
    """OrcaSlicer hits this to verify the host is OctoPrint-compatible."""
    return {
        "api": "0.1",
        "server": "1.3.0",
        "text": "OctoPrint 1.3.0 (monofarm shim)",
    }


@router.get("/printer")
def octo_printer(
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Connection test endpoint — always returns Operational."""
    _resolve_user(x_api_key, db)
    return {
        "state": {
            "flags": {
                "operational": True,
                "printing": False,
                "paused": False,
                "ready": True,
                "error": False,
                "closedOrError": False,
                "finishing": False,
                "cancelling": False,
            },
            "text": "Operational",
        },
        "temperature": {
            "tool0": {"actual": 0.0, "target": 0.0, "offset": 0},
            "bed": {"actual": 0.0, "target": 0.0, "offset": 0},
        },
    }


@router.post("/files/local", status_code=status.HTTP_201_CREATED)
async def octo_upload(
    file: UploadFile,
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Receive a gcode upload from OrcaSlicer and store it in the central file library."""
    user = _resolve_user(x_api_key, db)

    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename")

    _p = Path(file.filename)
    ext = ("".join(_p.suffixes)).lower() if len(_p.suffixes) > 1 else _p.suffix.lower()
    if not any(ext.endswith(a) for a in ALLOWED_EXTS):
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File too large")

    stored_name = f"{uuid.uuid4().hex}{ext}"
    parse_path = GCODES_DIR / stored_name
    parse_path.write_bytes(contents)
    filament_meta: dict | None = None
    try:
        parsed = parse_gcode(parse_path)
        filament_meta = parsed if parsed else None
    except Exception:
        pass
    if storage_svc.is_s3():
        try:
            storage_svc.put(stored_name, contents, user.organization_id)
        finally:
            parse_path.unlink(missing_ok=True)

    row = GcodeFile(
        organization_id=user.organization_id,
        stored_name=stored_name,
        original_name=file.filename,
        size_bytes=len(contents),
        filament_meta=filament_meta,
        uploaded_by_id=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    # Frontend URL for the Device tab webview in OrcaSlicer
    frontend = settings.FARM_PUBLIC_URL.rstrip("/")
    backend = "http://localhost:8000"
    files_url = f"{frontend}/files?highlight={row.id}"

    return {
        "done": True,
        "files": {
            "local": {
                "name": row.original_name,
                "origin": "local",
                "path": row.original_name,
                "refs": {
                    "download": f"{backend}/api/files/{row.id}/download",
                    "resource": files_url,
                },
            }
        },
        # OrcaSlicer opens this URL in the "Device" tab webview
        "url": files_url,
    }
