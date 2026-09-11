"""Multi-worker AutoPrint guards use separate Postgres transactions, not mocks."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Barrier
from unittest.mock import Mock
import uuid

import pytest
from sqlalchemy.orm import sessionmaker

from app.core import db as core_db
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.organization import Organization
from app.models.plan import PlanEntry
from app.models.printer import Printer, PrinterKind
from app.models.task import PrintTask
from app.services import autoprint, bambu


@pytest.fixture
def committed_run(db_engine):
    # The usual outer rollback fixture cannot be observed by a second connection.
    sessions = sessionmaker(db_engine, expire_on_commit=False)
    with sessions() as db:
        org = Organization(name="Concurrency test", slug=f"concurrency-{uuid.uuid4().hex}")
        db.add(org)
        db.flush()
        printer = Printer(organization_id=org.id, name="AutoPrint", kind=PrinterKind.bambu, bambu_dev_id="TEST",
                          autoprint_mode="platecycler", autoprint_plates_remaining=3)
        task = PrintTask(organization_id=org.id, title="Test part")
        db.add_all([printer, task])
        db.flush()
        entry = PlanEntry(organization_id=org.id, plan_date=date.today(), printer_id=printer.id, task_id=task.id,
                          runs_total=3, runs_completed=0)
        db.add(entry)
        db.flush()
        job = BambuCloudJob(organization_id=org.id, printer_id=printer.id, status=BambuCloudJobStatus.completed,
                            correlation_id=uuid.uuid4().hex, idempotency_key=uuid.uuid4().hex,
                            plan_entry_id=entry.id, autoprint_run_index=1)
        db.add(job)
        db.commit()
        ids = org.id, printer.id, task.id, entry.id, job.id
    try:
        yield sessions, ids
    finally:
        with sessions() as db:
            for model, row_id in [(BambuCloudJob, ids[4]), (PlanEntry, ids[3]), (PrintTask, ids[2]),
                                  (Printer, ids[1]), (Organization, ids[0])]:
                db.query(model).filter(model.id == row_id).delete(synchronize_session=False)
            db.commit()


def test_two_terminal_event_consumers_count_the_run_once(committed_run):
    sessions, (_, printer_id, _, entry_id, job_id) = committed_run
    barrier = Barrier(2)

    def consume():
        with sessions() as db:
            job = db.get(BambuCloudJob, job_id)
            # Both consumers begin with identical (and soon stale) ORM objects.
            printer, entry = db.get(Printer, printer_id), db.get(PlanEntry, entry_id)
            assert printer.autoprint_plates_remaining == 3
            assert entry.runs_completed == 0
            barrier.wait(timeout=5)
            result = autoprint.record_completed_run(db, job)
            db.commit()
            return result

    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second = executor.submit(consume), executor.submit(consume)
        assert sorted([first.result(timeout=5), second.result(timeout=5)]) == [False, True]
    with sessions() as db:
        assert db.get(Printer, printer_id).autoprint_plates_remaining == 2
        assert db.get(PlanEntry, entry_id).runs_completed == 1


def test_second_worker_skips_printer_while_first_is_creating_a_job(committed_run, monkeypatch):
    sessions, (_, printer_id, _, _, _) = committed_run
    monkeypatch.setattr(core_db, "SessionLocal", sessions)
    state = Mock(return_value={"state": "offline"})
    monkeypatch.setattr(bambu, "get_cached_state", state)
    with sessions() as first:
        first.query(Printer).filter(Printer.id == printer_id).with_for_update().one()
        assert asyncio.run(autoprint.start_next_for_printer(printer_id)) is None
        state.assert_not_called()
        first.rollback()
    assert asyncio.run(autoprint.start_next_for_printer(printer_id)) is None
    state.assert_called_once()
