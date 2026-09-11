"""Trusted-LAN setup and status web interface."""
from __future__ import annotations

import asyncio
import html as _htmlmod
import json
import logging
import os
import sys
import threading
import urllib.parse as _urlparse_mod

from core.config import _load_config, _save_config
from core.state import LOG_BUFFER, runtime_state
from core.updates import check_for_update
from printers import bambu, moonraker
from transports import telegram

log = logging.getLogger("monofarm-agent")


def _schedule_restart(delay: float = 0.7) -> None:
    """Restart the agent process shortly after the HTTP response is sent."""
    def _do() -> None:
        log.info("Restarting agent (web UI request)…")
        os.execv(sys.executable, [sys.executable] + sys.argv)
    loop = runtime_state.main_loop
    if loop is not None:
        loop.call_soon_threadsafe(lambda: loop.call_later(delay, _do))
    else:
        threading.Timer(delay, _do).start()

def _web_state() -> dict:
    bambu_status = []
    for dev_id, task in bambu._bambu_lan_sub_tasks.items():
        client = bambu._bambu_lan_live_clients.get(dev_id)
        connected = bool(client is not None and getattr(client, "is_connected", lambda: False)())
        ip = bambu._bambu_lan_sub_configs.get(dev_id, ("", ""))[0]
        bambu_status.append({"dev_id": dev_id, "ip": ip, "connected": connected, "alive": not task.done()})
    moonraker_status = [{"url": url, "alive": not task.done()} for url, task in moonraker._moonraker_sub_tasks.items()]
    return {
        "version": runtime_state.version,
        "server": runtime_state.server or _load_config().get("MONOFARM_SERVER", ""),
        "cloud_connected": runtime_state.cloud_connected,
        "has_token": bool(_load_config().get("MONOFARM_TOKEN")),
        "tg_running": telegram.is_running(),
        "bambu": bambu_status,
        "moonraker": moonraker_status,
        "alert_chat_ids": telegram.get_alert_chat_ids(),
    }

def _h(value: object) -> str:
    return _htmlmod.escape(str(value), quote=True)

_WEB_CSS = """
body{background:#101216;color:#e6e8eb;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
     margin:0;padding:24px;max-width:760px;margin-inline:auto}
h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:20px 0 8px;color:#9aa1ab}
a{color:#7ab8ff} .muted{color:#9aa1ab}
.card{background:#171a20;border:1px solid #262b33;border-radius:10px;padding:14px 16px;margin:10px 0}
.chip{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:#11331f;color:#5fd38a} .bad{background:#3a1a1a;color:#ff8c8c} .idle{background:#252a33;color:#9aa1ab}
table{width:100%;border-collapse:collapse} td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #20252d;font-size:13px}
input{background:#0d0f13;color:#e6e8eb;border:1px solid #2a3039;border-radius:8px;padding:7px 10px;width:100%;box-sizing:border-box}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:7px 14px;font-weight:600;cursor:pointer}
button.ghost{background:#252a33} form.inline{display:inline}
pre{background:#0d0f13;border:1px solid #20252d;border-radius:8px;padding:10px;font-size:12px;
    overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:480px;overflow-y:auto}
label{display:block;margin:8px 0 3px;font-size:12px;color:#9aa1ab}
"""

def _web_page(title: str, body: str, refresh: int | None = None) -> bytes:
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ""
    return (
        f"<!doctype html><html><head><meta charset='utf-8'>{meta}"
        f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{_h(title)}</title><style>{_WEB_CSS}</style></head>"
        f"<body><h1>monofarm-agent <span class='muted'>v{_h(runtime_state.version)}</span></h1>"
        f"{body}</body></html>"
    ).encode("utf-8")

def _render_dashboard() -> bytes:
    st = _web_state()
    cloud_chip = (
        "<span class='chip ok'>підключено</span>" if st["cloud_connected"]
        else "<span class='chip bad'>немає зв'язку</span>"
    )
    tg_chip = "<span class='chip ok'>працює</span>" if st["tg_running"] else "<span class='chip idle'>вимкнено</span>"
    token_chip = "<span class='chip ok'>збережено</span>" if st["has_token"] else "<span class='chip bad'>немає</span>"

    bambu_rows = "".join(
        f"<tr><td>{_h(p['dev_id'])}</td><td>{_h(p['ip'])}</td>"
        f"<td>{'<span class=chip ok>online</span>' if p['connected'] else '<span class=chip idle>reconnect…</span>'}</td></tr>"
        for p in st["bambu"]
    ) or "<tr><td colspan=3 class=muted>немає LAN-принтерів (додаються в monofarm Settings)</td></tr>"

    mr_rows = "".join(
        f"<tr><td>{_h(m['url'])}</td>"
        f"<td>{'<span class=chip ok>підписка</span>' if m['alive'] else '<span class=chip idle>reconnect…</span>'}</td></tr>"
        for m in st["moonraker"]
    ) or "<tr><td colspan=2 class=muted>немає Moonraker-принтерів</td></tr>"

    logs_tail = "\n".join(list(LOG_BUFFER)[-25:])

    body = f"""
<div class='card'>
  <table>
    <tr><td>Хмара ({_h(st['server'])})</td><td>{cloud_chip}</td></tr>
    <tr><td>Токен</td><td>{token_chip}</td></tr>
    <tr><td>Telegram-бот</td><td>{tg_chip}</td></tr>
  </table>
  <div style='margin-top:10px'>
    <form class='inline' method='post' action='/update'><button class='ghost'>Перевірити оновлення</button></form>
    <form class='inline' method='post' action='/restart'><button class='ghost'>Перезапустити</button></form>
  </div>
</div>
<h2>Bambu LAN принтери</h2>
<div class='card'><table><tr><th>Серійник</th><th>IP</th><th>MQTT</th></tr>{bambu_rows}</table>
  <form method='post' action='/scan' style='margin-top:10px'><button>Сканувати мережу (SSDP)</button></form>
</div>
<h2>Moonraker принтери</h2>
<div class='card'><table>{mr_rows}</table></div>
<h2>Алерти про збої (Telegram)</h2>
<div class='card'>
  <p class='muted'>Додай бота у груповий чат і напиши там <code>/тривоги_тут</code> —
  цей чат отримуватиме фото + текст + код помилки при збоях і зупинках. Або вкажи chat_id вручну:</p>
  <form method='post' action='/alerts'>
    <label>Chat IDs (через кому)</label>
    <input name='chat_ids' value='{_h(",".join(str(i) for i in st["alert_chat_ids"]))}'>
    <div style='margin-top:10px'><button>Зберегти</button></div>
  </form>
</div>
<h2>Підключення до monofarm</h2>
<div class='card'>
  <form method='post' action='/pair'>
    <label>Server URL</label><input name='server' value='{_h(st['server'])}'>
    <label>Token (JWT — лиши порожнім, щоб не змінювати)</label><input name='token' type='password' autocomplete='off'>
    <div style='margin-top:10px'><button>Зберегти й перезапустити</button></div>
  </form>
</div>
<h2>Журнал <a href='/logs' style='font-weight:400;font-size:12px'>повний →</a></h2>
<pre>{_h(logs_tail)}</pre>
"""
    return _web_page("monofarm-agent", body, refresh=5)

def _render_scan() -> bytes:
    try:
        devices = bambu._bambu_ssdp_scan(4.0)
    except Exception as e:
        return _web_page("Сканування", f"<div class='card'>Помилка сканування: {_h(e)}</div><a href='/'>← назад</a>")
    rows = "".join(
        f"<tr><td>{_h(d['dev_id'])}</td><td>{_h(d['ip'])}</td><td>{_h(d['name'])}</td><td>{_h(d['model'])}</td></tr>"
        for d in devices
    ) or "<tr><td colspan=4 class=muted>нічого не знайдено — переконайся, що принтери в LAN-режимі й у цій же мережі</td></tr>"
    body = (
        f"<h2>Знайдені принтери</h2><div class='card'><table>"
        f"<tr><th>Серійник</th><th>IP</th><th>Назва</th><th>Модель</th></tr>{rows}</table></div>"
        f"<p class='muted'>Додай принтер у monofarm → Settings, вказавши IP та Access Code з екрана принтера.</p>"
        f"<a href='/'>← назад</a>"
    )
    return _web_page("Сканування", body)

def _start_web_ui(port: int) -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class _Handler(BaseHTTPRequestHandler):
        def _send(self, payload: bytes, code: int = 200, ctype: str = "text/html; charset=utf-8") -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _redirect(self, location: str = "/") -> None:
            self.send_response(303)
            self.send_header("Location", location)
            self.end_headers()

        def _form(self) -> dict[str, str]:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8", errors="ignore") if length else ""
            return {k: v[0] for k, v in _urlparse_mod.parse_qs(raw).items()}

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/" or self.path.startswith("/?"):
                self._send(_render_dashboard())
            elif self.path == "/logs":
                body = f"<a href='/'>← назад</a><pre>{_h(chr(10).join(LOG_BUFFER))}</pre>"
                self._send(_web_page("Журнал", body, refresh=3))
            elif self.path == "/healthz":
                self._send(json.dumps(_web_state()).encode(), ctype="application/json")
            else:
                self._send(b"not found", code=404, ctype="text/plain")

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/scan":
                self._send(_render_scan())
            elif self.path == "/pair":
                form = self._form()
                cfg = _load_config()
                server = (form.get("server") or cfg.get("MONOFARM_SERVER") or "").strip().rstrip("/")
                token = (form.get("token") or "").strip() or cfg.get("MONOFARM_TOKEN", "")
                _save_config(server, token)
                self._send(_web_page("Збережено", "<div class='card'>Налаштування збережено — агент перезапускається…</div><a href='/'>← на головну</a>"))
                _schedule_restart()
            elif self.path == "/update":
                loop = runtime_state.main_loop
                if loop is not None and runtime_state.server:
                    asyncio.run_coroutine_threadsafe(check_for_update(runtime_state.server, runtime_state.version), loop)
                self._redirect("/")
            elif self.path == "/restart":
                self._send(_web_page("Перезапуск", "<div class='card'>Агент перезапускається…</div><a href='/'>← на головну</a>"))
                _schedule_restart()
            elif self.path == "/alerts":
                form = self._form()
                ids: list[int] = []
                for part in (form.get("chat_ids") or "").split(","):
                    part = part.strip()
                    if not part:
                        continue
                    try:
                        ids.append(int(part))
                    except ValueError:
                        pass
                telegram.set_alert_chat_ids(ids)
                self._redirect("/")
            else:
                self._send(b"not found", code=404, ctype="text/plain")

        def log_message(self, *_args) -> None:
            pass  # keep the agent log clean of HTTP access noise

    try:
        httpd = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    except OSError as e:
        log.warning("Web UI not started on :%s (%s)", port, e)
        return
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log.info("Web UI: http://localhost:%s (доступний у локальній мережі)", port)


start_web_ui = _start_web_ui
