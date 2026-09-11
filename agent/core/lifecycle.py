"""Process lifecycle and local file logging."""
from __future__ import annotations

import logging
import os

from core.config import CONFIG_DIR

_instance_lock_handle = None


def acquire_single_instance() -> bool:
    """Return True if we got the lock; False if another agent is already running.

    Prevents two agents fighting over the same printers' MQTT/Telegram connections.
    """
    global _instance_lock_handle
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        fh = open(CONFIG_DIR / "agent.lock", "w")  # noqa: SIM115
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                fh.close()
                return False
        else:
            import fcntl
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                fh.close()
                return False
        fh.write(str(os.getpid()))
        fh.flush()
        _instance_lock_handle = fh
        return True
    except Exception:
        return True

def setup_file_logging() -> None:
    """Add a rotating file log at ~/.monofarm-agent/agent.log (bounded size)."""
    try:
        from logging.handlers import RotatingFileHandler
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        fh = RotatingFileHandler(
            CONFIG_DIR / "agent.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8",
        )
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))
        logging.getLogger().addHandler(fh)
    except Exception:
        pass
