"""Persistent edge-agent configuration."""
from __future__ import annotations

import os
from pathlib import Path

CONFIG_DIR = Path.home() / ".monofarm-agent"
CONFIG_FILE = CONFIG_DIR / ".env"


def _load_config() -> dict[str, str]:
    cfg = {"MONOFARM_SERVER": "https://api.monofarm.app", "MONOFARM_FRONTEND": "https://monofarm.app", "MONOFARM_TOKEN": ""}
    if CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip()
    return cfg

def _write_config(cfg: dict[str, str]) -> None:
    """Atomically persist config (temp + os.replace) so a crash can't truncate it."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    data = "".join(f"{k}={v}\n" for k, v in cfg.items() if v != "")
    tmp = CONFIG_DIR / ".env.tmp"
    tmp.write_text(data, encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except Exception:
        pass
    os.replace(tmp, CONFIG_FILE)

def _save_config(server: str, token: str) -> None:
    cfg = _load_config()
    cfg["MONOFARM_SERVER"] = server
    cfg["MONOFARM_TOKEN"] = token
    _write_config(cfg)

def _load_alert_chat_ids() -> list[int]:
    out: list[int] = []
    for part in (_load_config().get("ALERT_CHAT_IDS", "") or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            pass
    return out

def _save_alert_chat_ids(ids: list[int]) -> None:
    cfg = _load_config()
    cfg["ALERT_CHAT_IDS"] = ",".join(str(i) for i in ids)
    _write_config(cfg)
