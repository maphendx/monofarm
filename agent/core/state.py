"""Small shared runtime state used by the relay loop and local status UI."""
from __future__ import annotations

import asyncio
import collections
import logging
from dataclasses import dataclass, field


log = logging.getLogger("monofarm-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

LOG_BUFFER: collections.deque[str] = collections.deque(maxlen=500)


class LogBufferHandler(logging.Handler):
    """Keep a bounded copy of logs for local and cloud diagnostics."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            LOG_BUFFER.append(self.format(record))
        except Exception:
            return


@dataclass
class RuntimeState:
    version: str = ""
    server: str = ""
    cloud_connected: bool = False
    main_loop: asyncio.AbstractEventLoop | None = None
    update_task: asyncio.Task[None] | None = None
    upload_buffers: dict[str, dict] = field(default_factory=dict)


runtime_state = RuntimeState()


def _install_log_buffer() -> None:
    root = logging.getLogger()
    if any(isinstance(handler, LogBufferHandler) for handler in root.handlers):
        return
    handler = LogBufferHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))
    root.addHandler(handler)


_install_log_buffer()
