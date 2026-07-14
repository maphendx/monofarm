"""Validation contracts for durable protocol-v2 envelopes."""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas.agent import AgentCommandCreate, AgentEventCreate, AgentPairRequest


def test_agent_command_schema_rejects_unknown_fields_and_expired_deadlines() -> None:
    valid = {
        "agent_device_id": uuid4(),
        "command_type": "printer.pause",
        "payload": {},
        "idempotency_key": "pause-job-42",
        "deadline_at": datetime.now(timezone.utc) + timedelta(minutes=1),
    }

    with pytest.raises(ValidationError):
        AgentCommandCreate(**valid, arbitrary_url="http://169.254.169.254")

    with pytest.raises(ValidationError):
        AgentCommandCreate(**{**valid, "deadline_at": datetime.now(timezone.utc) - timedelta(seconds=1)})


def test_agent_event_schema_requires_non_negative_monotonic_sequence() -> None:
    with pytest.raises(ValidationError):
        AgentEventCreate(
            agent_device_id=uuid4(),
            monotonic_sequence=-1,
            event_type="printer.status",
            payload={},
            occurred_at_device=datetime.now(timezone.utc),
        )


def test_agent_pair_schema_forbids_untyped_extra_fields() -> None:
    with pytest.raises(ValidationError):
        AgentPairRequest(
            pairing_code="mf_pair_test",
            public_key=base64.b64encode(bytes(range(32))).decode("ascii"),
            capabilities=["moonraker"],
            organization_id=999,
        )


def test_agent_pair_schema_requires_base64_encoded_raw_ed25519_public_key() -> None:
    encoded_key = base64.b64encode(bytes(range(32))).decode("ascii")

    parsed = AgentPairRequest(
        pairing_code="mf_pair_" + "a" * 24,
        public_key=encoded_key,
        capabilities=[],
    )

    assert parsed.public_key == encoded_key
    with pytest.raises(ValidationError):
        AgentPairRequest(
            pairing_code="mf_pair_" + "a" * 24,
            public_key="ed25519:" + "a" * 64,
            capabilities=[],
        )
    with pytest.raises(ValidationError):
        AgentPairRequest(
            pairing_code="mf_pair_" + "a" * 24,
            public_key=base64.b64encode(b"short").decode("ascii"),
            capabilities=[],
        )
