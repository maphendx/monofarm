from __future__ import annotations

import pytest

from app.models.agent import AgentCommandState
from app.services.agent_commands import (
    InvalidAgentCommandTransition,
    canonical_payload_sha256,
    highest_contiguous_sequence,
    validate_agent_command_transition,
)


def test_canonical_payload_hash_is_stable_across_key_order() -> None:
    first = canonical_payload_sha256({"file": "part.3mf", "options": {"speed": 100, "bed": "pei"}})
    reordered = canonical_payload_sha256({"options": {"bed": "pei", "speed": 100}, "file": "part.3mf"})

    assert first == reordered
    assert len(first) == 64


@pytest.mark.parametrize(
    ("current", "target"),
    [
        (AgentCommandState.leased, AgentCommandState.accepted),
        (AgentCommandState.leased, AgentCommandState.failed),
        (AgentCommandState.accepted, AgentCommandState.executing),
        (AgentCommandState.executing, AgentCommandState.delivered),
        (AgentCommandState.executing, AgentCommandState.terminal),
        (AgentCommandState.delivered, AgentCommandState.printer_ack),
        (AgentCommandState.printer_ack, AgentCommandState.terminal),
        (AgentCommandState.needs_reconcile, AgentCommandState.executing),
        (AgentCommandState.needs_reconcile, AgentCommandState.printer_ack),
        (AgentCommandState.needs_reconcile, AgentCommandState.failed),
    ],
)
def test_command_transition_graph_allows_only_forward_or_reconciliation_outcomes(
    current: AgentCommandState,
    target: AgentCommandState,
) -> None:
    assert validate_agent_command_transition(current, target)
    assert not validate_agent_command_transition(target, target)


@pytest.mark.parametrize(
    ("current", "target"),
    [
        (AgentCommandState.queued, AgentCommandState.accepted),
        (AgentCommandState.leased, AgentCommandState.executing),
        (AgentCommandState.executing, AgentCommandState.accepted),
        (AgentCommandState.delivered, AgentCommandState.executing),
        (AgentCommandState.terminal, AgentCommandState.failed),
        (AgentCommandState.failed, AgentCommandState.terminal),
    ],
)
def test_command_transition_graph_rejects_skips_regressions_and_terminal_changes(
    current: AgentCommandState,
    target: AgentCommandState,
) -> None:
    with pytest.raises(InvalidAgentCommandTransition):
        validate_agent_command_transition(current, target)


@pytest.mark.parametrize(
    ("sequences", "expected"),
    [
        ([], 0),
        ([2, 3], 0),
        ([1, 2, 4, 5], 2),
        ([1, 2, 3], 3),
        ([3, 2, 1, 2], 3),
    ],
)
def test_highest_contiguous_sequence_stops_at_first_gap(
    sequences: list[int],
    expected: int,
) -> None:
    assert highest_contiguous_sequence(sequences) == expected
