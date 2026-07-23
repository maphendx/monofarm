from __future__ import annotations

from types import SimpleNamespace

from app.services.queue_targeting import is_eligible, target_reasons


def _task(assigned_group_id=None, target_printer_ids=None):
    return SimpleNamespace(assigned_group_id=assigned_group_id, target_printer_ids=target_printer_ids)


def _printer(id_, group_id=None):
    return SimpleNamespace(id=id_, group_id=group_id)


def test_no_targeting_matches_any_printer():
    task = _task()
    assert is_eligible(task, _printer(1, group_id=5))
    assert target_reasons(task, _printer(1, group_id=5)) == []


def test_group_only_excludes_other_groups():
    task = _task(assigned_group_id=7)
    assert is_eligible(task, _printer(1, group_id=7))
    assert not is_eligible(task, _printer(2, group_id=8))
    assert not is_eligible(task, _printer(3, group_id=None))


def test_printer_list_only_excludes_unlisted_printers():
    task = _task(target_printer_ids=[10, 11])
    assert is_eligible(task, _printer(10))
    assert is_eligible(task, _printer(11))
    assert not is_eligible(task, _printer(12))


def test_group_and_printer_list_both_must_match():
    task = _task(assigned_group_id=7, target_printer_ids=[10, 11])
    assert is_eligible(task, _printer(10, group_id=7))
    # right group, wrong printer id
    assert not is_eligible(task, _printer(99, group_id=7))
    # right printer id, wrong group
    assert not is_eligible(task, _printer(10, group_id=8))


def test_empty_printer_list_treated_as_unset():
    task = _task(target_printer_ids=[])
    assert is_eligible(task, _printer(1, group_id=None))
