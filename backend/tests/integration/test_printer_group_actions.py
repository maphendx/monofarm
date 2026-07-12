from __future__ import annotations

from unittest.mock import AsyncMock

from app.models.printer import Printer, PrinterKind
from app.models.printer_group import PrinterGroup
from app.models.tag import Tag, TagKind
from app.models.task import FarmTask


def _group(db, org_id: int, name: str = "A1 Mini farm") -> PrinterGroup:
    group = PrinterGroup(organization_id=org_id, name=name, sort_order=1)
    db.add(group)
    db.commit()
    db.refresh(group)
    return group


def _printer(db, org_id: int, group_id: int, name: str, **overrides) -> Printer:
    values = {
        "organization_id": org_id,
        "group_id": group_id,
        "name": name,
        "kind": PrinterKind.bambu,
        "bambu_dev_id": f"030-{name}",
        "bambu_dev_ip": "192.168.1.10",
        "bambu_access_code": "12345678",
        "bambu_model": "A1 mini",
        "bambu_lan_mode": True,
        "autoprint_mode": "off",
    }
    values.update(overrides)
    printer = Printer(**values)
    db.add(printer)
    db.commit()
    db.refresh(printer)
    return printer


def test_group_action_marks_only_group_printers_out_of_order(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    group = _group(db_session, test_org.id)
    first = _printer(db_session, test_org.id, group.id, "A1-01")
    second = _printer(db_session, test_org.id, group.id, "A1-02")
    other_group = _group(db_session, test_org.id, "Other")
    untouched = _printer(db_session, test_org.id, other_group.id, "A1-03")

    response = client.post(
        f"/api/printer-groups/{group.id}/actions",
        headers=auth_headers,
        json={"action": "mark_out_of_order"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["affected"] == 2
    db_session.refresh(first)
    db_session.refresh(second)
    db_session.refresh(untouched)
    assert first.is_out_of_order is True
    assert second.is_out_of_order is True
    assert untouched.is_out_of_order is False


def test_group_action_creates_real_maintenance_task(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    group = _group(db_session, test_org.id)
    _printer(db_session, test_org.id, group.id, "A1-01")

    response = client.post(
        f"/api/printer-groups/{group.id}/actions",
        headers=auth_headers,
        json={
            "action": "create_maintenance",
            "title": "Щотижневе ТО",
            "description": "Очистити та змастити осі",
            "deadline": "2026-07-06",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["affected"] == 1
    assert body["task_id"] is not None
    task = db_session.get(FarmTask, body["task_id"])
    assert task is not None
    assert task.title == "Щотижневе ТО"
    assert "A1 Mini farm" in (task.description or "")
    assert "Очистити та змастити осі" in (task.description or "")


def test_group_action_enables_autoprint_and_reports_skipped_printers(
    client,
    auth_headers,
    db_session,
    test_org,
    monkeypatch,
) -> None:
    group = _group(db_session, test_org.id)
    eligible = _printer(db_session, test_org.id, group.id, "A1-01")
    unsupported = _printer(
        db_session,
        test_org.id,
        group.id,
        "P1S-01",
        bambu_dev_id="P1S-01",
        bambu_model="P1S",
    )
    start_next = AsyncMock(return_value=None)
    monkeypatch.setattr("app.services.autoprint.start_next_for_printer", start_next)

    response = client.post(
        f"/api/printer-groups/{group.id}/actions",
        headers=auth_headers,
        json={
            "action": "enable_autoprint",
            "plates_loaded": 4,
            "cooldown_temp_c": 35,
            "delay_seconds": 90,
            "eject_last_plate": False,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["affected"] == 1
    assert body["skipped"] == [
        {
            "printer_id": unsupported.id,
            "printer_name": "P1S-01",
            "reason": "AutoPrint підтримує лише Bambu A1 Mini",
        }
    ]
    db_session.refresh(eligible)
    db_session.refresh(unsupported)
    assert eligible.autoprint_mode == "platecycler"
    assert eligible.autoprint_plates_remaining == 4
    assert eligible.autoprint_cooldown_temp_c == 35
    assert eligible.autoprint_delay_seconds == 90
    assert eligible.autoprint_eject_last_plate is False
    assert unsupported.autoprint_mode == "off"
    start_next.assert_awaited_once_with(eligible.id)


def test_group_action_adds_tags_without_duplicating_existing(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    group = _group(db_session, test_org.id)
    already_tagged = _printer(db_session, test_org.id, group.id, "A1-01")
    untagged = _printer(db_session, test_org.id, group.id, "A1-02")
    other_group = _group(db_session, test_org.id, "Other")
    untouched = _printer(db_session, test_org.id, other_group.id, "A1-03")

    tag_a = Tag(organization_id=test_org.id, kind=TagKind.custom, label="urgent", color="#ff0000")
    tag_b = Tag(organization_id=test_org.id, kind=TagKind.custom, label="calibrated", color="#00ff00")
    db_session.add_all([tag_a, tag_b])
    db_session.commit()
    db_session.refresh(tag_a)
    db_session.refresh(tag_b)

    already_tagged.tags = [tag_a]
    db_session.commit()

    response = client.post(
        f"/api/printer-groups/{group.id}/actions",
        headers=auth_headers,
        json={"action": "add_tags", "tag_ids": [tag_a.id, tag_b.id]},
    )

    assert response.status_code == 200, response.text
    assert response.json()["affected"] == 2
    db_session.refresh(already_tagged)
    db_session.refresh(untagged)
    db_session.refresh(untouched)
    assert {t.id for t in already_tagged.tags} == {tag_a.id, tag_b.id}
    assert {t.id for t in untagged.tags} == {tag_a.id, tag_b.id}
    assert untouched.tags == []


def test_group_action_add_tags_requires_selection(
    client,
    auth_headers,
    db_session,
    test_org,
) -> None:
    group = _group(db_session, test_org.id)
    _printer(db_session, test_org.id, group.id, "A1-01")

    response = client.post(
        f"/api/printer-groups/{group.id}/actions",
        headers=auth_headers,
        json={"action": "add_tags", "tag_ids": []},
    )

    assert response.status_code == 400
