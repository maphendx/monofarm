from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.security import create_access_token, hash_password
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole


def _platform_admin(db_session: Session) -> User:
    user = User(
        organization_id=None,
        email="platform@example.com",
        password_hash=hash_password("test-platform-pw"),
        name="Platform Admin",
        role=UserRole.admin,
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _headers(user: User) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value, org_id=user.organization_id)
    return {"Authorization": f"Bearer {token}"}


def test_platform_admin_can_read_phase_1_admin_overview(
    client,
    db_session: Session,
    test_org: Organization,
) -> None:
    admin = _platform_admin(db_session)

    resp = client.get("/api/admin/overview", headers=_headers(admin))

    assert resp.status_code == 200
    assert resp.json()["organizations_total"] >= 1


def test_tenant_admin_cannot_access_admin_api(client, auth_headers: dict[str, str]) -> None:
    resp = client.get("/api/admin/overview", headers=auth_headers)

    assert resp.status_code == 403


def test_tenant_admin_still_accesses_old_tenant_routes(client, auth_headers: dict[str, str]) -> None:
    resp = client.get("/api/printers", headers=auth_headers)

    assert resp.status_code == 200


def test_operator_still_accesses_old_tenant_routes(client, operator_user: User) -> None:
    resp = client.get("/api/printers", headers=_headers(operator_user))

    assert resp.status_code == 200


def test_platform_admin_without_impersonation_cannot_read_tenant_route(client, db_session: Session) -> None:
    admin = _platform_admin(db_session)

    resp = client.get("/api/printers", headers=_headers(admin))

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Organization context required"


def test_impersonation_header_is_rejected_for_non_platform_users(
    client,
    auth_headers: dict[str, str],
    test_org: Organization,
) -> None:
    resp = client.get("/api/printers", headers={**auth_headers, "X-Impersonated-Org-Id": str(test_org.id)})

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Impersonation requires platform admin"


def test_platform_admin_impersonation_is_read_only(
    client,
    db_session: Session,
    test_org: Organization,
) -> None:
    admin = _platform_admin(db_session)
    db_session.add(
        Printer(
            organization_id=test_org.id,
            name="Readonly Printer",
            kind=PrinterKind.other,
            manual_status="idle",
            manual_updated_at=datetime.now(timezone.utc),
        )
    )
    db_session.commit()

    headers = {**_headers(admin), "X-Impersonated-Org-Id": str(test_org.id)}

    read_resp = client.get("/api/printers", headers=headers)
    write_resp = client.post("/api/printers", headers=headers, json={"name": "Blocked", "kind": "other"})

    assert read_resp.status_code == 200
    assert write_resp.status_code == 403
    assert write_resp.json()["detail"] == "Impersonation is read-only"
