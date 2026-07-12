"""File storage: local disk or S3-compatible (Cloudflare R2 / AWS S3).

S3 key pattern: orgs/{org_id}/{prefix}/{stored_name}
Local pattern:  data/{prefix}/{stored_name}

All functions are sync; call from async via asyncio.to_thread where needed.
"""
from __future__ import annotations

import logging
import tempfile
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from typing import Generator

log = logging.getLogger(__name__)

_BASE = Path(__file__).resolve().parent.parent.parent / "data"

# Legacy alias kept for files.py backward compatibility
LOCAL_DIR = _BASE / "gcodes"
LOCAL_DIR.mkdir(parents=True, exist_ok=True)


def _local_dir(prefix: str) -> Path:
    d = _BASE / prefix
    d.mkdir(parents=True, exist_ok=True)
    return d


def is_s3() -> bool:
    from app.core.config import settings
    return bool(settings.S3_BUCKET)


def _s3_key(stored_name: str, org_id: int, prefix: str) -> str:
    return f"orgs/{org_id}/{prefix}/{stored_name}"


@lru_cache(maxsize=1)
def _client():
    # boto3 clients are thread-safe and reusable; building one per call is the
    # dominant cost when generating presigned URLs for product lists. Cache it.
    from app.core.config import settings
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT_URL or None,
        aws_access_key_id=settings.S3_ACCESS_KEY,
        aws_secret_access_key=settings.S3_SECRET_KEY,
        config=Config(signature_version="s3v4"),
    )


def put(stored_name: str, data: bytes, org_id: int, prefix: str = "gcodes") -> None:
    if is_s3():
        from app.core.config import settings
        _client().put_object(
            Bucket=settings.S3_BUCKET,
            Key=_s3_key(stored_name, org_id, prefix),
            Body=data,
        )
    else:
        (_local_dir(prefix) / stored_name).write_bytes(data)


def put_file(stored_name: str, path: Path, org_id: int, prefix: str = "gcodes") -> None:
    """Upload from a local file path.

    Uses boto3 upload_file (multipart, streaming) for S3 — avoids loading the
    entire file into RAM. Use instead of put() for files larger than ~20 MB.
    """
    if is_s3():
        from app.core.config import settings
        _client().upload_file(str(path), settings.S3_BUCKET, _s3_key(stored_name, org_id, prefix))
    else:
        dest = _local_dir(prefix) / stored_name
        if path != dest:
            import shutil
            shutil.copy2(path, dest)


def exists(stored_name: str, org_id: int, prefix: str = "gcodes") -> bool:
    if is_s3():
        from app.core.config import settings
        try:
            _client().head_object(Bucket=settings.S3_BUCKET, Key=_s3_key(stored_name, org_id, prefix))
            return True
        except Exception:
            return False
    return (_local_dir(prefix) / stored_name).exists()


def get_bytes(stored_name: str, org_id: int, prefix: str = "gcodes") -> bytes:
    if is_s3():
        from app.core.config import settings
        obj = _client().get_object(
            Bucket=settings.S3_BUCKET,
            Key=_s3_key(stored_name, org_id, prefix),
        )
        return obj["Body"].read()
    path = _local_dir(prefix) / stored_name
    if not path.exists():
        raise FileNotFoundError(stored_name)
    return path.read_bytes()


def delete(stored_name: str, org_id: int, prefix: str = "gcodes") -> None:
    if is_s3():
        from app.core.config import settings
        _client().delete_object(
            Bucket=settings.S3_BUCKET,
            Key=_s3_key(stored_name, org_id, prefix),
        )
    else:
        (_local_dir(prefix) / stored_name).unlink(missing_ok=True)


def presigned_url(stored_name: str, org_id: int, prefix: str = "gcodes", expires: int = 3600) -> str | None:
    """Return a presigned download URL (S3 only). Returns None for local backend."""
    if not is_s3():
        return None
    from app.core.config import settings
    return _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": _s3_key(stored_name, org_id, prefix)},
        ExpiresIn=expires,
    )


def presigned_url_raw(key: str, expires: int = 3600) -> str | None:
    """Presigned GET URL for a NON org-scoped bucket key (e.g. the agent .exe).

    For global release artifacts uploaded by CI. Returns None on the local backend
    or when the object does not exist yet (so callers can 404 cleanly).
    """
    if not is_s3():
        return None
    from app.core.config import settings
    try:
        _client().head_object(Bucket=settings.S3_BUCKET, Key=key)
    except Exception:
        return None
    return _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": key},
        ExpiresIn=expires,
    )


@contextmanager
def local_path_for(stored_name: str, org_id: int, prefix: str = "gcodes") -> Generator[Path, None, None]:
    """Yield a local Path to the file.

    Local backend: yields the stored path directly (no copy, no cleanup).
    S3 backend: downloads to a temp file, yields that path, then cleans up.
    """
    if not is_s3():
        path = _local_dir(prefix) / stored_name
        if not path.exists():
            raise FileNotFoundError(stored_name)
        yield path
        return

    suffix = "".join(Path(stored_name).suffixes) or Path(stored_name).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        from app.core.config import settings
        _client().download_file(
            settings.S3_BUCKET,
            _s3_key(stored_name, org_id, prefix),
            str(tmp_path),
        )
        yield tmp_path
    finally:
        tmp_path.unlink(missing_ok=True)
