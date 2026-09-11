"""Frozen and source-distribution self updates."""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import httpx


log = logging.getLogger("monofarm-agent")
UPDATE_INTERVAL = 6 * 3600


async def check_for_update(server: str, current_version: str) -> None:
    """Download and apply a newer agent release, when one is available."""
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(f"{server}/api/agent/version")
            if response.status_code != 200:
                return
            remote = response.json().get("version", "")
            if not remote or remote == current_version:
                return
            log.info("Update available: %s → %s. Downloading…", current_version, remote)
            if getattr(sys, "frozen", False):
                await _apply_frozen_update(client, server, remote)
            else:
                await _apply_source_update(client, server, remote)
    except Exception as exc:
        log.debug("Update check skipped: %s", exc)


def _validated_archive_files(payload: bytes) -> tuple[tuple[str, ...], dict[str, bytes]]:
    """Read the source bundle and reject missing, extra, or unsafe members."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        try:
            source_files = tuple(json.loads(archive.read("source_manifest.json")))
        except (KeyError, json.JSONDecodeError, TypeError) as exc:
            raise ValueError("invalid source archive manifest") from exc
        if not source_files or any(not isinstance(name, str) for name in source_files):
            raise ValueError("invalid source archive manifest")
        if len(source_files) != len(set(source_files)):
            raise ValueError("duplicate source archive member")
        expected = set(source_files)
        names = set(archive.namelist())
        if names != expected:
            missing = sorted(expected - names)
            extra = sorted(names - expected)
            raise ValueError(f"invalid source archive (missing={missing}, extra={extra})")
        files: dict[str, bytes] = {}
        for name in source_files:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"unsafe archive path: {name}")
            files[name] = archive.read(name)
        if "monofarm_agent.py" not in files:
            raise ValueError("source archive is missing its entrypoint")
        return source_files, files


async def _apply_source_update(
    client: httpx.AsyncClient,
    server: str,
    remote: str,
) -> None:
    """Replace the complete source tree, writing the entrypoint last."""
    response = await client.get(f"{server}/agent/source.zip")
    response.raise_for_status()
    source_files, files = _validated_archive_files(response.content)

    # core/updates.py lives two levels below the installed agent root.
    agent_root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="monofarm-agent-update-") as temp_dir:
        stage = Path(temp_dir)
        for name, content in files.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)

        # Existing headless installs should stay headless. All other package
        # modules are replaced before the version-bearing entrypoint, so an
        # interrupted update remains on the old reported version.
        for name in source_files:
            if name in {"monofarm_agent.py", "monofarm_tray.py"}:
                continue
            target = agent_root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage / name, target)
        tray = agent_root / "monofarm_tray.py"
        if tray.exists():
            os.replace(stage / "monofarm_tray.py", tray)
        os.replace(stage / "monofarm_agent.py", agent_root / "monofarm_agent.py")

    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--quiet",
                "-r",
                str(agent_root / "requirements-core.txt"),
            ],
            check=False,
            timeout=60,
        )
    except Exception as exc:
        log.debug("Dependency refresh skipped: %s", exc)
    log.info("Updated to %s. Restarting…", remote)
    os.execv(sys.executable, [sys.executable, *sys.argv])


async def _apply_frozen_update(
    client: httpx.AsyncClient,
    server: str,
    remote: str,
) -> None:
    """Hot-swap the Windows executable and relaunch it."""
    executable = Path(sys.executable).resolve()
    new = executable.parent / (executable.stem + ".new.exe")
    old = executable.parent / (executable.stem + ".old.exe")
    response = await client.get(f"{server}/agent/monofarm-agent.exe")
    response.raise_for_status()
    new.write_bytes(response.content)
    try:
        old.unlink(missing_ok=True)
    except Exception:
        pass
    os.replace(executable, old)
    os.replace(new, executable)
    log.info("Updated to %s. Relaunching…", remote)
    subprocess.Popen([str(executable)], close_fds=True)
    os._exit(0)


def cleanup_old_exe() -> None:
    """Delete the executable left behind by the previous frozen update."""
    if not getattr(sys, "frozen", False):
        return
    try:
        executable = Path(sys.executable).resolve()
        (executable.parent / (executable.stem + ".old.exe")).unlink(missing_ok=True)
    except Exception:
        pass


async def update_loop(server: str, current_version: str) -> None:
    while True:
        await asyncio.sleep(UPDATE_INTERVAL)
        await check_for_update(server, current_version)


# Compatibility with the pre-package private names.
_cleanup_old_exe = cleanup_old_exe
_update_loop = update_loop
