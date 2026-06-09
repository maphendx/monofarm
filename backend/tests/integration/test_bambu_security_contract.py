from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.files import _BAMBU_SEND_LIMIT, _bambu_send_hits, _check_bambu_send_rate_limit
from app.core.security import create_access_token
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.printer import Printer, PrinterKind
from app.services.bambu_errors import BambuErrorCode, error_details
from app.workers.bambu_jobs import MAX_RETRY_COUNT


def _headers_for(user, org_id: int) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value, org_id=org_id)
    return {"Authorization": f"Bearer {token}"}


def test_bambu_health_requires_admin(client, operator_user, test_org):
    resp = client.get("/api/orgs/me/bambu-health", headers=_headers_for(operator_user, test_org.id))

    assert resp.status_code == 403


def test_bambu_job_retry_invalid_id_returns_404(client, auth_headers):
    resp = client.post("/api/bambu-jobs/999999/retry", headers=auth_headers)

    assert resp.status_code == 404


def test_bambu_job_retry_limit_returns_409(client, auth_headers, db_session, test_org):
    printer = Printer(
        organization_id=test_org.id,
        name="Retry Limit",
        kind=PrinterKind.bambu,
        bambu_dev_id="SEC-RETRY",
        is_active=True,
    )
    db_session.add(printer)
    db_session.flush()
    job = BambuCloudJob(
        organization_id=test_org.id,
        printer_id=printer.id,
        printer_bambu_dev_id="SEC-RETRY",
        file_name="retry.3mf",
        status=BambuCloudJobStatus.failed,
        correlation_id="sec-corr-retry",
        idempotency_key="sec-idem-retry",
        error_code=BambuErrorCode.TASK_CREATE_FAILED.value,
        error_details_json=error_details(BambuErrorCode.TASK_CREATE_FAILED),
        retry_count=MAX_RETRY_COUNT,
        failed_at=datetime.now(timezone.utc),
    )
    db_session.add(job)
    db_session.commit()

    resp = client.post(f"/api/bambu-jobs/{job.id}/retry", headers=auth_headers)

    assert resp.status_code == 409
    assert "retry limit" in resp.json()["detail"].lower()


def test_bambu_send_code_is_rate_limited(client, auth_headers, monkeypatch):
    from app.api import orgs

    monkeypatch.setattr(orgs.bambu_provider, "send_email_code", lambda base, email: SimpleNamespace(status_code=200))
    headers = {**auth_headers, "X-Forwarded-For": "203.0.113.77"}

    statuses = [
        client.post(
            "/api/orgs/me/bambu-send-code",
            headers=headers,
            json={"email": "owner@example.com", "region": "us"},
        ).status_code
        for _ in range(6)
    ]

    assert statuses[:5] == [200, 200, 200, 200, 200]
    assert statuses[5] == 429


def test_bambu_send_to_printer_rate_guard_limits_per_org_and_ip():
    request = SimpleNamespace(headers={}, client=SimpleNamespace(host="198.51.100.25"))
    _bambu_send_hits.clear()

    for _ in range(_BAMBU_SEND_LIMIT):
        _check_bambu_send_rate_limit(request, org_id=123)

    with pytest.raises(HTTPException) as exc:
        _check_bambu_send_rate_limit(request, org_id=123)
    assert exc.value.status_code == 429

    _check_bambu_send_rate_limit(request, org_id=124)
