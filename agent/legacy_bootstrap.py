#!/usr/bin/env python3
"""Signed-release bootstrap for pre-modular Monofarm source agents.

This file is served at the historical ``/agent/monofarm_agent.py`` URL. It
migrates an installed single-file agent to the signed modular runtime without
ever activating a partial source bundle.
"""

from __future__ import annotations

import base64
import binascii
import compileall
import hashlib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    HTTPSHandler,
    Request,
    build_opener,
)


DEFAULT_SERVER = "https://api.monofarm.app"
BUILTIN_RELEASE_PUBLIC_KEY = "2Doaw17ATYHVEEIT9VAVb2Y3HInyNM8sesvLU9Uz33M="
CONFIG_DIR = Path.home() / ".monofarm-agent"
RUNTIME_SOURCE_FILES = frozenset(
    {
        "monofarm_agent.py",
        "monofarm_tray.py",
        "command_runtime.py",
        "command_worker.py",
        "device_identity.py",
        "network_policy.py",
        "printer_runtime.py",
        "provider_adapters.py",
        "update_policy.py",
        "requirements.txt",
        "edge_runtime/__init__.py",
        "edge_runtime/adapters.py",
        "edge_runtime/artifact_spool.py",
        "edge_runtime/journal.py",
        "edge_runtime/registry.py",
        "edge_runtime/transfer.py",
    }
)

_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
_MAX_REQUIREMENTS_BYTES = 1024 * 1024
_MAX_SOURCE_BYTES = 16 * 1024 * 1024
_MAX_CLOCK_SKEW = timedelta(minutes=5)
_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_RELEASE_MANIFEST_SCHEMA_VERSION = 2
_RELEASE_MANIFEST_ALGORITHM = "Ed25519"
_MANIFEST_FIELDS = frozenset(
    {
        "schema_version",
        "algorithm",
        "key_id",
        "version",
        "issued_at",
        "expires_at",
        "artifacts",
        "signature",
    }
)


class BootstrapError(RuntimeError):
    """Raised when the legacy migration cannot be completed safely."""


def require_https_url(url: str) -> str:
    """Return an HTTPS URL or fail closed."""

    if not isinstance(url, str):
        raise BootstrapError("URL must be a string")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise BootstrapError(f"HTTPS URL required: {url!r}")
    return url


class HTTPSOnlyRedirectHandler(HTTPRedirectHandler):
    """Reject redirect chains that leave HTTPS."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require_https_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_bytes(url: str, max_bytes: int) -> bytes:
    """Download a bounded response using verified TLS and HTTPS-only redirects."""

    require_https_url(url)
    if max_bytes <= 0:
        raise BootstrapError("download size limit must be positive")
    opener = build_opener(
        HTTPSOnlyRedirectHandler(),
        HTTPSHandler(context=ssl.create_default_context()),
    )
    request = Request(url, headers={"User-Agent": "monofarm-legacy-bootstrap/1"})
    try:
        with opener.open(request, timeout=45) as response:
            require_https_url(response.geturl())
            declared_length = response.headers.get("Content-Length")
            if declared_length and int(declared_length) > max_bytes:
                raise BootstrapError("download exceeds configured size limit")
            data = response.read(max_bytes + 1)
    except BootstrapError:
        raise
    except Exception as exc:
        raise BootstrapError(f"HTTPS download failed: {exc}") from exc
    if len(data) > max_bytes:
        raise BootstrapError("download exceeds configured size limit")
    return data


def fetch_json(url: str, max_bytes: int = _MAX_MANIFEST_BYTES) -> dict:
    try:
        payload = json.loads(fetch_bytes(url, max_bytes).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BootstrapError("server returned invalid update JSON") from exc
    if not isinstance(payload, dict):
        raise BootstrapError("update response must be an object")
    return payload


def _canonical_manifest_bytes(manifest: dict) -> bytes:
    unsigned = {key: value for key, value in manifest.items() if key != "signature"}
    return json.dumps(
        unsigned,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _parse_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise BootstrapError(f"manifest {field} is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BootstrapError(f"manifest {field} is invalid") from exc
    if parsed.tzinfo is None:
        raise BootstrapError(f"manifest {field} must include timezone")
    return parsed.astimezone(timezone.utc)


def _verify_ed25519_signature(
    encoded_public_key: str,
    signature: bytes,
    payload: bytes,
) -> bool:
    """Verify with cryptography when installed, otherwise the system OpenSSL."""

    try:
        public_key = base64.b64decode(encoded_public_key, validate=True)
    except (TypeError, ValueError, binascii.Error):
        return False
    if len(public_key) != 32:
        return False

    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        InvalidSignature = None
    else:
        try:
            Ed25519PublicKey.from_public_bytes(public_key).verify(signature, payload)
            return True
        except (ValueError, InvalidSignature):
            return False

    # Ed25519 SubjectPublicKeyInfo prefix (RFC 8410), followed by the raw key.
    spki = bytes.fromhex("302a300506032b6570032100") + public_key
    pem_body = base64.b64encode(spki).decode("ascii")
    pem = (
        "-----BEGIN PUBLIC KEY-----\n"
        + "\n".join(pem_body[index : index + 64] for index in range(0, len(pem_body), 64))
        + "\n-----END PUBLIC KEY-----\n"
    )
    try:
        with tempfile.TemporaryDirectory(prefix="monofarm-signature-") as directory:
            root = Path(directory)
            public_path = root / "public.pem"
            payload_path = root / "manifest.bin"
            signature_path = root / "signature.bin"
            _write_file(public_path, pem.encode("ascii"))
            _write_file(payload_path, payload)
            _write_file(signature_path, signature)
            result = subprocess.run(
                [
                    "openssl",
                    "pkeyutl",
                    "-verify",
                    "-pubin",
                    "-inkey",
                    str(public_path),
                    "-rawin",
                    "-in",
                    str(payload_path),
                    "-sigfile",
                    str(signature_path),
                ],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _release_key_id(encoded_public_key: str) -> str | None:
    try:
        public_key = base64.b64decode(encoded_public_key, validate=True)
    except (TypeError, ValueError, binascii.Error):
        return None
    if len(public_key) != 32:
        return None
    return hashlib.sha256(public_key).hexdigest()[:16]


def verify_signed_manifest(
    manifest: dict,
    *,
    trusted_public_keys: Sequence[str],
    now: datetime | None = None,
) -> dict:
    """Verify signature, freshness, and the exact modular source set."""

    if not isinstance(manifest, dict) or set(manifest) != _MANIFEST_FIELDS:
        raise BootstrapError("signed update manifest is missing")
    if not trusted_public_keys:
        raise BootstrapError("no trusted update signing key is available")
    try:
        signature = base64.b64decode(manifest.get("signature", ""), validate=True)
    except (TypeError, ValueError, binascii.Error) as exc:
        raise BootstrapError("manifest signature is invalid") from exc

    if (
        manifest.get("schema_version") != _RELEASE_MANIFEST_SCHEMA_VERSION
        or manifest.get("algorithm") != _RELEASE_MANIFEST_ALGORITHM
    ):
        raise BootstrapError("manifest signing identity is invalid")
    matching_keys = [
        key
        for key in trusted_public_keys
        if _release_key_id(key) == manifest.get("key_id")
    ]
    if not matching_keys:
        raise BootstrapError("manifest signing key is not pinned")
    canonical = _canonical_manifest_bytes(manifest)
    if not any(
        _verify_ed25519_signature(encoded_key, signature, canonical)
        for encoded_key in matching_keys
    ):
        raise BootstrapError("manifest signature is not trusted")

    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    issued_at = _parse_timestamp(manifest.get("issued_at"), "issued_at")
    expires_at = _parse_timestamp(manifest.get("expires_at"), "expires_at")
    if issued_at > current_time + _MAX_CLOCK_SKEW:
        raise BootstrapError("manifest issued_at is in the future")
    if expires_at <= current_time or expires_at <= issued_at:
        raise BootstrapError("signed update manifest expired")

    version = manifest.get("version")
    if not isinstance(version, str) or _VERSION_RE.fullmatch(version) is None:
        raise BootstrapError("manifest version is invalid")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        raise BootstrapError("manifest artifacts are missing")

    expected_names = {"windows-x86_64"} | {
        f"source-{name}" for name in RUNTIME_SOURCE_FILES
    }
    if set(artifacts) != expected_names:
        raise BootstrapError("manifest artifact set is incomplete or unexpected")

    for filename in RUNTIME_SOURCE_FILES:
        artifact = artifacts.get(f"source-{filename}")
        if not isinstance(artifact, dict):
            raise BootstrapError(f"source artifact {filename} is invalid")
        url = artifact.get("url")
        size = artifact.get("size")
        sha256 = artifact.get("sha256")
        require_https_url(url)
        if type(size) is not int or not 0 < size <= _MAX_SOURCE_BYTES:
            raise BootstrapError(f"source artifact {filename} size is invalid")
        if not isinstance(sha256, str) or _SHA256_RE.fullmatch(sha256) is None:
            raise BootstrapError(f"source artifact {filename} SHA-256 is invalid")

    windows = artifacts["windows-x86_64"]
    if not isinstance(windows, dict) or set(windows) != {"url", "size", "sha256"}:
        raise BootstrapError("Windows release artifact is invalid")
    require_https_url(windows.get("url"))
    if type(windows.get("size")) is not int or not 0 < windows["size"] <= 2 * 1024**3:
        raise BootstrapError("Windows release artifact size is invalid")
    if not isinstance(windows.get("sha256"), str) or _SHA256_RE.fullmatch(
        windows["sha256"]
    ) is None:
        raise BootstrapError("Windows release artifact SHA-256 is invalid")

    return json.loads(json.dumps(manifest))


def verify_artifact(data: bytes, artifact: dict) -> None:
    expected_size = artifact["size"]
    expected_sha256 = artifact["sha256"]
    if len(data) != expected_size:
        raise BootstrapError(
            f"artifact size mismatch: expected {expected_size}, got {len(data)}"
        )
    actual_sha256 = hashlib.sha256(data).hexdigest()
    if actual_sha256 != expected_sha256:
        raise BootstrapError("artifact SHA-256 mismatch")


def _write_file(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def _activate_release(current_link: Path, release: Path) -> None:
    current_link.parent.mkdir(parents=True, exist_ok=True)
    next_link = current_link.with_name(f".{current_link.name}.new-{os.getpid()}")
    next_link.unlink(missing_ok=True)
    try:
        next_link.symlink_to(release.resolve(), target_is_directory=True)
        os.replace(next_link, current_link)
    finally:
        next_link.unlink(missing_ok=True)


def install_release(
    manifest: dict,
    *,
    releases_dir: Path,
    current_link: Path,
    fetch: Callable[[str, int], bytes] = fetch_bytes,
    health_check: Callable[[Path], None] | None = None,
) -> Path:
    """Download, verify, stage, and atomically activate one source release."""

    artifacts = manifest["artifacts"]
    downloads: dict[str, bytes] = {}
    for filename in sorted(RUNTIME_SOURCE_FILES):
        artifact = artifacts[f"source-{filename}"]
        data = fetch(artifact["url"], artifact["size"])
        verify_artifact(data, artifact)
        downloads[filename] = data

    releases_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".incoming-", dir=releases_dir))
    release: Path | None = None
    try:
        for filename, data in downloads.items():
            relative = PurePosixPath(filename)
            _write_file(staging.joinpath(*relative.parts), data)
        if not compileall.compile_dir(staging, quiet=1, force=True):
            raise BootstrapError("downloaded runtime failed Python compilation")
        if health_check is not None:
            health_check(staging)
        marker = staging / ".complete"
        _write_file(marker, f"{manifest['version']}\n".encode("utf-8"))

        release = releases_dir / f"{manifest['version']}-{time.time_ns()}"
        os.replace(staging, release)
        _activate_release(current_link, release)
        return release
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        if release is not None and release.exists():
            shutil.rmtree(release, ignore_errors=True)
        raise


def preflight_release(release: Path) -> None:
    """Import the complete candidate runtime before changing ``current``."""

    try:
        subprocess.run(
            [
                sys.executable,
                str(release / "monofarm_agent.py"),
                "--update-health-check",
            ],
            cwd=release,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=45,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise BootstrapError("candidate runtime health check failed") from exc


def _load_config(config_file: Path) -> dict[str, str]:
    config: dict[str, str] = {}
    if not config_file.is_file():
        return config
    for raw_line in config_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        config[key.strip()] = value.strip()
    return config


def persist_update_key(config_file: Path, public_key: str) -> None:
    """Persist an operator-provisioned signing key without discarding config."""

    config_file.parent.mkdir(parents=True, exist_ok=True)
    lines = config_file.read_text(encoding="utf-8").splitlines() if config_file.exists() else []
    prefix = "MONOFARM_UPDATE_PUBLIC_KEYS="
    replacement = f"{prefix}{public_key}"
    updated: list[str] = []
    replaced = False
    for line in lines:
        if line.strip().startswith(prefix):
            if not replaced:
                updated.append(replacement)
                replaced = True
        else:
            updated.append(line)
    if not replaced:
        updated.append(replacement)

    temporary = config_file.with_name(f".{config_file.name}.new-{os.getpid()}")
    try:
        _write_file(temporary, ("\n".join(updated) + "\n").encode("utf-8"))
        os.chmod(temporary, 0o600)
        os.replace(temporary, config_file)
    finally:
        temporary.unlink(missing_ok=True)


def install_requirements(requirements: bytes, config_dir: Path) -> None:
    if not requirements:
        raise BootstrapError("distributed requirements file is empty")
    config_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=".requirements-",
        suffix=".txt",
        dir=config_dir,
        delete=False,
    ) as temporary:
        requirements_path = Path(temporary.name)
        temporary.write(requirements)
        temporary.flush()
        os.fsync(temporary.fileno())
    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "--requirement",
                str(requirements_path),
            ],
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise BootstrapError("failed to install modular agent requirements") from exc
    finally:
        requirements_path.unlink(missing_ok=True)


def _server_from_args(args: Sequence[str], config: dict[str, str]) -> str:
    server = ""
    for index, argument in enumerate(args):
        if argument == "--server":
            if index + 1 >= len(args):
                raise BootstrapError("--server requires a value")
            server = args[index + 1]
            break
        if argument.startswith("--server="):
            server = argument.split("=", 1)[1]
            break
    server = (
        server
        or os.environ.get("MONOFARM_SERVER", "")
        or config.get("MONOFARM_SERVER", "")
        or DEFAULT_SERVER
    ).rstrip("/")
    return require_https_url(server)


def _configured_public_keys(config: dict[str, str]) -> list[str]:
    raw = (
        os.environ.get("MONOFARM_UPDATE_PUBLIC_KEYS", "")
        or config.get("MONOFARM_UPDATE_PUBLIC_KEYS", "")
    )
    keys = [item.strip() for item in raw.split(",") if item.strip()]
    return list(dict.fromkeys([*keys, BUILTIN_RELEASE_PUBLIC_KEY]))


def _current_entrypoint(current_link: Path) -> Path | None:
    entrypoint = current_link / "monofarm_agent.py"
    if (current_link / ".complete").is_file() and entrypoint.is_file():
        return entrypoint
    return None


def _exec_agent(entrypoint: Path, args: Sequence[str]) -> None:
    os.execv(sys.executable, [sys.executable, str(entrypoint), *args])


def run(
    args: Sequence[str] | None = None,
    config_dir: Path = CONFIG_DIR,
) -> Path | None:
    """Migrate once, then act as a stable launcher for the activated runtime."""

    arguments = list(sys.argv[1:] if args is None else args)
    install_only = "--install-only" in arguments
    arguments = [argument for argument in arguments if argument != "--install-only"]
    current_link = config_dir / "current"
    entrypoint = _current_entrypoint(current_link)
    if entrypoint is not None:
        if install_only:
            return entrypoint.parent
        _exec_agent(entrypoint, arguments)
        return None

    config_file = config_dir / ".env"
    config = _load_config(config_file)
    server = _server_from_args(arguments, config)
    response = fetch_json(f"{server}/api/agent/version")
    trusted_keys = _configured_public_keys(config)
    manifest = verify_signed_manifest(
        response.get("manifest"),
        trusted_public_keys=trusted_keys,
    )
    if response.get("version") != manifest["version"]:
        raise BootstrapError("version response does not match signed manifest")

    requirements_artifact = manifest["artifacts"]["source-requirements.txt"]
    requirements = fetch_bytes(
        requirements_artifact["url"],
        min(requirements_artifact["size"], _MAX_REQUIREMENTS_BYTES),
    )
    verify_artifact(requirements, requirements_artifact)
    install_requirements(requirements, config_dir)

    release = install_release(
        manifest,
        releases_dir=config_dir / "releases",
        current_link=current_link,
        health_check=preflight_release,
    )
    if install_only:
        return release
    _exec_agent(release / "monofarm_agent.py", arguments)
    return None


def main() -> int:
    try:
        run()
    except BootstrapError as exc:
        print(f"monofarm legacy bootstrap failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
