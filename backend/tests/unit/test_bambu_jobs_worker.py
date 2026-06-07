from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.models.bambu_cloud_job import BambuCloudJobStatus
from app.services.bambu_errors import BambuErrorCode
from app.workers import bambu_jobs


class FakeSession:
    def __init__(self, jobs: dict[int, SimpleNamespace]):
        self.jobs = jobs

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def get(self, _model, job_id: int):
        return self.jobs.get(job_id)

    def commit(self) -> None:
        pass

    def refresh(self, _obj) -> None:
        pass

    def expunge(self, _obj) -> None:
        pass


def _factory(jobs: dict[int, SimpleNamespace]):
    return lambda: FakeSession(jobs)


def _job(**overrides) -> SimpleNamespace:
    base = dict(
        id=1,
        printer_id=10,
        organization_id=20,
        status=BambuCloudJobStatus.queued,
        retry_count=0,
        error_code=None,
        error_details_json=None,
        failed_at=None,
        updated_at=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def clear_worker_locks():
    with bambu_jobs._running_guard:
        bambu_jobs._running_job_ids.clear()
    with bambu_jobs._printer_locks_guard:
        bambu_jobs._printer_locks.clear()
    with bambu_jobs._org_semaphores_guard:
        bambu_jobs._org_semaphores.clear()
    yield


def test_run_bambu_cloud_job_dispatches_queued_job_to_task_created():
    job = _job()
    jobs = {job.id: job}

    def dispatch(job_id: int):
        assert job_id == job.id
        job.status = BambuCloudJobStatus.task_created
        return job

    result = bambu_jobs.run_bambu_cloud_job(job.id, session_factory=_factory(jobs), dispatch_fn=dispatch)

    assert result is job
    assert result.status == BambuCloudJobStatus.task_created


def test_run_bambu_cloud_job_does_not_dispatch_when_printer_lock_is_held():
    job = _job()
    jobs = {job.id: job}
    dispatch = MagicMock()
    lock = bambu_jobs._printer_lock(job.printer_id)
    assert lock.acquire(blocking=False)
    try:
        result = bambu_jobs.run_bambu_cloud_job(job.id, session_factory=_factory(jobs), dispatch_fn=dispatch)
    finally:
        lock.release()

    assert result is None
    dispatch.assert_not_called()
    assert job.status == BambuCloudJobStatus.queued


def test_run_bambu_cloud_job_bumps_retry_count_for_retryable_dispatch_failure():
    job = _job()
    jobs = {job.id: job}

    def dispatch(_job_id: int):
        job.status = BambuCloudJobStatus.failed
        job.error_details_json = {"retryable": True}
        return job

    result = bambu_jobs.run_bambu_cloud_job(job.id, session_factory=_factory(jobs), dispatch_fn=dispatch)

    assert result is job
    assert result.status == BambuCloudJobStatus.failed
    assert result.retry_count == 1


def test_run_bambu_cloud_job_uses_taxonomy_retryability():
    job = _job()
    jobs = {job.id: job}

    def dispatch(_job_id: int):
        job.status = BambuCloudJobStatus.failed
        job.error_code = BambuErrorCode.TASK_CREATE_FAILED.value
        job.error_details_json = {"retryable": False}
        return job

    result = bambu_jobs.run_bambu_cloud_job(job.id, session_factory=_factory(jobs), dispatch_fn=dispatch)

    assert result is job
    assert result.retry_count == 1
