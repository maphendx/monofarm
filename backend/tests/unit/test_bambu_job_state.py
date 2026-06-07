from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.services.bambu_job_state import BambuJobTransitionError, can_transition, transition_job


def test_can_transition_allows_forward_lifecycle():
    assert can_transition(BambuCloudJobStatus.queued, BambuCloudJobStatus.validating)
    assert can_transition(BambuCloudJobStatus.task_created, BambuCloudJobStatus.acknowledged)
    assert can_transition(BambuCloudJobStatus.acknowledged, BambuCloudJobStatus.printing)
    assert can_transition(BambuCloudJobStatus.printing, BambuCloudJobStatus.completed)


def test_can_transition_blocks_illegal_terminal_jump():
    assert not can_transition(BambuCloudJobStatus.completed, BambuCloudJobStatus.printing)
    assert not can_transition(BambuCloudJobStatus.failed, BambuCloudJobStatus.task_created)
    job = BambuCloudJob(status=BambuCloudJobStatus.completed)
    with pytest.raises(BambuJobTransitionError):
        transition_job(job, BambuCloudJobStatus.printing)


def test_transition_job_stamps_timestamps_and_reason():
    now = datetime.now(timezone.utc) - timedelta(seconds=5)
    job = BambuCloudJob(status=BambuCloudJobStatus.task_created)

    transition_job(job, BambuCloudJobStatus.printing, reason="Started", now=now, progress_pct=7)

    assert job.status == BambuCloudJobStatus.printing
    assert job.status_reason == "Started"
    assert job.started_printing_at == now
    assert job.progress_pct == 7
