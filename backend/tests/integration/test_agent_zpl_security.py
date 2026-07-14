from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.models.user import User
from app.services import tunnel


@pytest.mark.parametrize(
    "target",
    [
        "127.0.0.1",
        "169.254.169.254",
        "224.0.0.1",
        "8.8.8.8",
        "0.0.0.0",
        "::1",
        "fe80::1",
        "ff02::1",
        "2606:4700:4700::1111",
    ],
)
def test_print_zpl_rejects_non_private_targets_before_using_tunnel(
    client,
    auth_headers: dict[str, str],
    monkeypatch,
    target: str,
) -> None:
    proxy = AsyncMock()
    monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: True)
    monkeypatch.setattr(tunnel, "proxy_request", proxy)

    response = client.post(
        "/api/agent/print-zpl",
        headers=auth_headers,
        json={"ip": target, "port": 9100, "zpl": "^XA^XZ"},
    )

    assert response.status_code == 400
    proxy.assert_not_awaited()


def test_print_zpl_requires_admin_role(
    client,
    operator_user: User,
    monkeypatch,
) -> None:
    from app.core.security import create_access_token

    token = create_access_token(
        subject=str(operator_user.id),
        role=operator_user.role.value,
        org_id=operator_user.organization_id,
    )
    monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: True)

    response = client.post(
        "/api/agent/print-zpl",
        headers={"Authorization": f"Bearer {token}"},
        json={"ip": "192.168.1.50", "port": 9100, "zpl": "^XA^XZ"},
    )

    assert response.status_code == 403


def test_print_zpl_accepts_literal_private_target_for_admin(
    client,
    auth_headers: dict[str, str],
    monkeypatch,
) -> None:
    proxy = AsyncMock(return_value={"status": 200, "body": {"ok": True}})
    monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: True)
    monkeypatch.setattr(tunnel, "proxy_request", proxy)

    response = client.post(
        "/api/agent/print-zpl",
        headers=auth_headers,
        json={"ip": "192.168.1.50", "port": 9100, "zpl": "^XA^XZ"},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert proxy.await_args.kwargs["body"]["ip"] == "192.168.1.50"


def test_print_zpl_rejects_hostnames_and_invalid_ports(
    client,
    auth_headers: dict[str, str],
) -> None:
    hostname = client.post(
        "/api/agent/print-zpl",
        headers=auth_headers,
        json={"ip": "printer.local", "port": 9100, "zpl": "^XA^XZ"},
    )
    bad_port = client.post(
        "/api/agent/print-zpl",
        headers=auth_headers,
        json={"ip": "192.168.1.50", "port": 70000, "zpl": "^XA^XZ"},
    )

    assert hostname.status_code == 422
    assert bad_port.status_code == 422
