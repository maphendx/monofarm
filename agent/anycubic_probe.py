"""Standalone LAN probe for an Anycubic Kobra 3 / S1 printer.

Run this from a machine that is actually on the printer's local network (the
farm PC running the monofarm agent, or any laptop on that LAN — NOT a machine
on a different network, even if it shares the same private IP range).

Usage:
    python anycubic_probe.py <printer-ip> [--seconds 15]

Requires: `pip install cryptography paho-mqtt` (both already in agent/requirements.txt).

What it does (read-only — no printer state is changed):
  1. GET /info, POST /ctrl handshake -> MQTT broker credentials.
  2. Connects to the local MQTT broker, subscribes to report topics, requests
     an `info` query and a `multiColorBox` getInfo, and prints what comes back
     for a few seconds.
  3. Probes whether a dispatch surface exists: an OctoPrint-compatible API on
     port 80, and whether `urls.fileUploadurl` from the info report responds.
     This does NOT upload anything — GET only.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

from anycubic_local import const, handshake, models


def _get(url: str, timeout: float = 4.0) -> tuple[int | None, str]:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            return resp.status, resp.read(400).decode(errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, ""
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)


def probe_dispatch_surface(ip: str, info: dict) -> None:
    print("\n=== Dispatch surface probe (read-only) ===")
    status, body = _get(f"http://{ip}/api/version")
    print(f"GET http://{ip}/api/version -> {status} {body[:120]!r}")
    status, body = _get(f"http://{ip}/api/server")
    print(f"GET http://{ip}/api/server  -> {status} {body[:120]!r}")

    upload_url = (info.get("urls") or {}).get("fileUploadurl")
    print(f"info.urls.fileUploadurl = {upload_url!r}")
    if upload_url:
        status, body = _get(upload_url)
        print(f"GET {upload_url} -> {status} {body[:200]!r}")

    print(f"features.gcode_3mf_support = {(info.get('features') or {}).get('gcode_3mf_support')!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ip")
    ap.add_argument("--seconds", type=float, default=15.0, help="how long to listen for MQTT reports")
    args = ap.parse_args()

    print(f"=== GET http://{args.ip}:18910/info ===")
    info = handshake._http_fetch("GET", f"http://{args.ip}:18910/info")
    print(json.dumps(info, indent=2))
    if info.get("ctrlType") != "lan":
        print(f"\nctrlType={info.get('ctrlType')!r} — printer is NOT in LAN mode. "
              "Enable LAN Mode: Settings -> Network -> LAN Mode, then re-run.", file=sys.stderr)
        return 1

    print("\n=== Handshake ===")
    hs = handshake.do_handshake(args.ip)
    print(f"broker={hs.broker_host}:{hs.broker_port} device_id={hs.device_id} "
          f"model_id={hs.model_id} model_name={hs.model_name} serial={hs.serial}")

    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        print("paho-mqtt not installed (`pip install paho-mqtt`) — skipping MQTT probe.", file=sys.stderr)
        probe_dispatch_surface(args.ip, info)
        return 0

    reports: list[tuple[str, dict]] = []

    def on_connect(client, userdata, flags, rc, properties=None):
        print(f"MQTT connected rc={rc}")
        client.subscribe(f"{const.report_prefix(hs.model_id, hs.device_id)}/#")
        for msg_type, action in (("info", "query"), ("multiColorBox", "getInfo")):
            body = json.dumps({"type": msg_type, "action": action, "timestamp": int(time.time() * 1000),
                                "msgid": "probe", "data": None})
            client.publish(const.query_topic(hs.model_id, hs.device_id, msg_type), body)

    def on_message(client, userdata, message):
        try:
            obj = json.loads(message.payload)
        except Exception:  # noqa: BLE001
            return
        reports.append((message.topic, obj))
        print(f"REPORT {message.topic} -> {json.dumps(obj)[:300]}")

    client = mqtt.Client(client_id="anycubic-probe", callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
    client.username_pw_set(hs.username, hs.password)
    client.tls_set(cert_reqs=__import__("ssl").CERT_NONE)
    client.tls_insecure_set(True)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(hs.broker_host, hs.broker_port, keepalive=30)
    client.loop_start()
    print(f"\n=== Listening for {args.seconds}s ===")
    time.sleep(args.seconds)
    client.loop_stop()
    client.disconnect()

    info_reports = [o for _t, o in reports if o.get("type") == "info"]
    if info_reports:
        state = models.parse_info(info_reports[-1].get("data") or {})
        print(f"\nParsed PrinterState: {state}")

    probe_dispatch_surface(args.ip, info)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
