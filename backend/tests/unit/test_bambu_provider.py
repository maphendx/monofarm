"""Unit tests for the raw Bambu Cloud HTTP provider. No network — `requests` is patched.

These pin the endpoint paths, payload shapes, and the two return conventions
(parsed-JSON-with-raise vs raw Response) that bambu.py / bambu_auth.py /
bambu_dispatch.py rely on.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import requests

from app.services import bambu_provider

BASE = "https://api.bambulab.com"


def _response(status_code: int = 200, json_data: dict | None = None) -> MagicMock:
    resp = MagicMock(spec=requests.Response)
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    if status_code >= 400:
        resp.raise_for_status.side_effect = requests.HTTPError(f"HTTP {status_code}")
    else:
        resp.raise_for_status.return_value = None
    return resp


def test_post_login_hits_login_endpoint_and_returns_json(monkeypatch):
    post = MagicMock(return_value=_response(json_data={"accessToken": "tok"}))
    monkeypatch.setattr(bambu_provider.requests, "post", post)

    data = bambu_provider.post_login(BASE, {"account": "a@b.c", "password": "x"})

    assert data == {"accessToken": "tok"}
    post.assert_called_once_with(
        f"{BASE}/v1/user-service/user/login",
        json={"account": "a@b.c", "password": "x"},
        timeout=bambu_provider.CLOUD_TIMEOUT,
    )


def test_post_refresh_token_sends_refresh_payload_and_raises_on_http_error(monkeypatch):
    post = MagicMock(return_value=_response(status_code=401))
    monkeypatch.setattr(bambu_provider.requests, "post", post)

    with pytest.raises(requests.HTTPError):
        bambu_provider.post_refresh_token(BASE, "rt-1")
    assert post.call_args.kwargs["json"] == {"refreshToken": "rt-1"}
    assert post.call_args.args[0] == f"{BASE}/v1/user-service/user/refreshtoken"


def test_send_email_code_returns_raw_response_without_raising(monkeypatch):
    post = MagicMock(return_value=_response(status_code=400))
    monkeypatch.setattr(bambu_provider.requests, "post", post)

    resp = bambu_provider.send_email_code(BASE, "owner@example.com")

    assert resp.status_code == 400
    assert post.call_args.kwargs["json"] == {"email": "owner@example.com", "type": "codeLogin"}


def test_get_user_bind_and_profile_parse_json(monkeypatch):
    get = MagicMock(return_value=_response(json_data={"devices": [{"dev_id": "D1"}]}))
    monkeypatch.setattr(bambu_provider.requests, "get", get)

    assert bambu_provider.get_user_bind(BASE, {"Authorization": "Bearer t"})["devices"][0]["dev_id"] == "D1"
    assert get.call_args.args[0] == f"{BASE}/v1/iot-service/api/user/bind"

    get.return_value = _response(json_data={"uid": 42})
    assert bambu_provider.get_user_profile(BASE, {})["uid"] == 42
    assert get.call_args.args[0] == f"{BASE}/v1/user-service/my/profile"


def test_get_device_version_passes_dev_id_param(monkeypatch):
    get = MagicMock(return_value=_response(json_data={"devices": []}))
    monkeypatch.setattr(bambu_provider.requests, "get", get)

    bambu_provider.get_device_version(BASE, {}, "DEV-9")

    assert get.call_args.args[0] == f"{BASE}/v1/iot-service/api/user/device/version"
    assert get.call_args.kwargs["params"] == {"dev_id": "DEV-9"}


def test_dispatch_stage_calls_return_raw_response_even_on_5xx(monkeypatch):
    post = MagicMock(return_value=_response(status_code=500))
    put = MagicMock(return_value=_response(status_code=500))
    monkeypatch.setattr(bambu_provider.requests, "post", post)
    monkeypatch.setattr(bambu_provider.requests, "put", put)

    assert bambu_provider.create_project(BASE, {}, "part.3mf").status_code == 500
    assert post.call_args.kwargs["json"] == {"name": "part.3mf"}

    assert bambu_provider.upload_to_oss("https://oss/presigned", b"abc").status_code == 500
    assert put.call_args.kwargs["timeout"] == bambu_provider.OSS_UPLOAD_TIMEOUT

    assert bambu_provider.create_task(BASE, {}, {"deviceId": "D1"}).status_code == 500
    assert post.call_args.args[0] == f"{BASE}/v1/user-service/my/task"


def test_extract_firmware_version_handles_known_shapes():
    assert bambu_provider.extract_firmware_version({}) is None
    assert bambu_provider.extract_firmware_version({"devices": []}) is None
    assert bambu_provider.extract_firmware_version({"devices": [{"firmware_version": "01.04.00.00"}]}) == "01.04.00.00"
    assert bambu_provider.extract_firmware_version({"devices": [{"version": "1.2.3"}]}) == "1.2.3"
    assert (
        bambu_provider.extract_firmware_version(
            {"devices": [{"firmware": [{"version": "01.08.02.00"}, {"version": "old"}]}]}
        )
        == "01.08.02.00"
    )
    assert bambu_provider.extract_firmware_version({"devices": [{"firmware": [{}]}]}) is None
