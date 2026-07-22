"""Unit tests for the ported Anycubic LAN protocol module (agent/anycubic_local/).

Crypto/handshake test vectors mirror chrisfore/anycubic_ha_local's test suite
(MIT License) so the ported implementation is checked against known-good values.
"""
import base64
import hashlib
import json

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

from anycubic_local import commands, const, handshake, models


def test_sign_matches_reference_algorithm():
    token = "0123456789abcdefABCDEF0123456789"
    ts = 1781548658398
    nonce = "abc123"
    expected = hashlib.md5(
        (hashlib.md5(token[:16].encode()).hexdigest() + str(ts) + nonce).encode()
    ).hexdigest()
    assert handshake.sign(token, ts, nonce) == expected
    assert len(handshake.sign(token, ts, nonce)) == 32
    # regression anchor: fixed expected value for these inputs
    assert handshake.sign(token, ts, nonce) == "3dc9739a6e5de8f075c6999fe3c3aaef"


def _encrypt(plaintext: bytes, token: str, local_token: str) -> str:
    key = token[16:32].encode()
    iv = local_token.encode()[:16].ljust(16, b"\0")
    padder = PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return base64.b64encode(enc.update(padded) + enc.finalize()).decode()


def test_decrypt_ctrl_roundtrip():
    token = "0123456789abcdef" + "FEDCBA9876543210"
    local_token = "localtok12345678"
    payload = {"broker": "mqtts://192.168.1.50:9883", "username": "u", "password": "p",
               "deviceId": "ea42a05c"}
    blob = _encrypt(json.dumps(payload).encode(), token, local_token)
    out = handshake.decrypt_ctrl(blob, token, local_token)
    assert out["broker"] == "mqtts://192.168.1.50:9883"
    assert out["deviceId"] == "ea42a05c"


def test_do_handshake_drives_full_flow():
    token = "0123456789abcdefABCDEF0123456789"
    local_token = "localtok12345678"
    info = {"token": token, "cn": "SER-1", "modelId": "20026",
            "modelName": "Anycubic Kobra 3 Max", "deviceType": "fdm",
            "ctrlInfoUrl": "http://1.2.3.4:18910/ctrl", "ctrlType": "lan"}
    decrypted = {"broker": "mqtts://1.2.3.4:9883", "username": "u", "password": "p",
                 "deviceId": "DEV-1"}
    ctrl = {"code": 200, "message": "success",
            "data": {"token": local_token,
                     "info": _encrypt(json.dumps(decrypted).encode(), token, local_token)}}

    calls = []

    def fake_fetch(method, url, **kw):
        calls.append((method, url))
        return info if url.endswith("/info") else ctrl

    res = handshake.do_handshake("1.2.3.4", fetch=fake_fetch)
    assert res.broker_host == "1.2.3.4" and res.broker_port == 9883
    assert res.username == "u" and res.password == "p"
    assert res.device_id == "DEV-1" and res.model_id == "20026" and res.serial == "SER-1"
    assert res.model_name == "Anycubic Kobra 3 Max" and res.device_type == "fdm"
    assert calls[0] == ("GET", "http://1.2.3.4:18910/info")
    assert calls[1][0] == "POST" and "/ctrl?" in calls[1][1] and "sign=" in calls[1][1]


def test_do_handshake_rejects_cloud_mode():
    def fake_fetch(method, url, **kw):
        return {"ctrlType": "cloud"}

    try:
        handshake.do_handshake("1.2.3.4", fetch=fake_fetch)
        raise AssertionError("expected CloudModeError")
    except handshake.CloudModeError:
        pass


def test_parse_info_maps_idle_state():
    state = models.parse_info({"model": "Kobra 3 Max", "state": "free", "temp": {}})
    assert state.status == "idle"
    assert state.printing is False


def test_parse_info_maps_printing_progress_and_temps():
    data = {
        "state": "busy",
        "temp": {"curr_nozzle_temp": 210.0, "target_nozzle_temp": 215.0,
                  "curr_hotbed_temp": 60.0, "target_hotbed_temp": 60.0},
        "project": {"state": "printing", "pause": 0, "progress": 42,
                     "curr_layer": 10, "total_layers": 100,
                     "remain_time": 30, "filename": "part.gcode"},
    }
    state = models.parse_info(data)
    assert state.printing is True
    assert state.paused is False
    assert state.progress == 42
    assert state.nozzle_temp == 210.0
    assert state.filename == "part.gcode"


def test_parse_info_maps_paused_state():
    data = {"state": "busy", "temp": {},
            "project": {"state": "paused", "pause": const.PAUSE_PAUSED}}
    state = models.parse_info(data)
    assert state.paused is True


def test_parse_multicolorbox_and_merge_preserves_known_values():
    first = models.parse_multicolorbox({"multi_color_box": [
        {"id": 0, "temp": 35, "humidity": 24,
         "slots": [{"index": 1, "type": "PETG", "color": [255, 0, 0], "status": 5}]},
    ]})
    # Second report omits temp/humidity (activity-gated) — must not clobber known values.
    second = models.parse_multicolorbox({"multi_color_box": [
        {"id": 0, "slots": [{"index": 2, "type": "PLA", "color": [0, 255, 0], "status": 4}]},
    ]})
    merged = models.merge_boxes(first, second)
    assert len(merged) == 1
    box = merged[0]
    assert box.temp == 35 and box.humidity == 24
    assert box.slots[1].material == "PETG" and box.slots[1].color_hex == "#FF0000"
    assert box.slots[2].material == "PLA"


def test_commands_pause_resume_stop_topic_and_payload():
    topic, payload = commands.build("20026", "DEV-1", "pause")
    assert topic == "anycubic/anycubicCloud/v1/web/printer/20026/DEV-1/print"
    assert payload["type"] == "print" and payload["action"] == "pause"
    assert payload["data"] == {"taskid": "-1"}


def test_commands_light_on_defaults_to_full_brightness():
    _topic, payload = commands.build("20026", "DEV-1", "light", on=True)
    assert payload["data"] == {"type": 2, "status": 1, "brightness": 100}


def test_commands_unknown_raises():
    try:
        commands.build("20026", "DEV-1", "not_a_command")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
