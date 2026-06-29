from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.user import User


def _headers(user: User) -> dict[str, str]:
    token = create_access_token(
        subject=str(user.id),
        role=user.role.value,
        org_id=user.organization_id,
    )
    return {"Authorization": f"Bearer {token}"}


def test_warehouse_notice_admin_can_update_and_clear(
    client: TestClient,
    auth_headers: dict[str, str],
):
    empty = client.get("/api/warehouse/notice", headers=auth_headers)
    assert empty.status_code == 200
    assert empty.json() == {
        "text": "",
        "updated_at": None,
        "expires_at": None,
        "active": False,
    }

    saved = client.put(
        "/api/warehouse/notice",
        json={"text": "  Планова інвентаризація о 18:00  "},
        headers=auth_headers,
    )
    assert saved.status_code == 200
    body = saved.json()
    assert body["text"] == "Планова інвентаризація о 18:00"
    assert body["updated_at"]
    assert body["expires_at"] is None
    assert body["active"] is True

    fetched = client.get("/api/warehouse/notice", headers=auth_headers)
    assert fetched.status_code == 200
    assert fetched.json() == body

    cleared = client.put("/api/warehouse/notice", json={"text": ""}, headers=auth_headers)
    assert cleared.status_code == 200
    assert cleared.json() == {
        "text": "",
        "updated_at": None,
        "expires_at": None,
        "active": False,
    }


def test_warehouse_notice_update_requires_admin(
    client: TestClient,
    operator_user: User,
    db_session: Session,
):
    db_session.refresh(operator_user)
    response = client.put(
        "/api/warehouse/notice",
        json={"text": "Не має зберегтись"},
        headers=_headers(operator_user),
    )
    assert response.status_code == 403
