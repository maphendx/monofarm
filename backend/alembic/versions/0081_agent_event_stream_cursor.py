"""add durable agent event stream identity and cursor

Revision ID: 0081
Revises: 0080
"""

from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0081"
down_revision = "0080"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_devices",
        sa.Column("current_event_stream_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "agent_devices",
        sa.Column(
            "current_event_cursor",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
    )
    op.add_column(
        "agent_events",
        sa.Column("event_stream_id", postgresql.UUID(as_uuid=True), nullable=True),
    )

    connection = op.get_bind()
    device_ids = list(
        connection.execute(
            sa.text("SELECT DISTINCT agent_device_id FROM agent_events")
        ).scalars()
    )
    for device_id in device_ids:
        stream_id = uuid.uuid4()
        sequences = connection.execute(
            sa.text(
                """
                SELECT monotonic_sequence
                FROM agent_events
                WHERE agent_device_id = :device_id
                ORDER BY monotonic_sequence
                """
            ),
            {"device_id": device_id},
        ).scalars()
        cursor = 0
        for sequence in sequences:
            if sequence == cursor + 1:
                cursor = sequence
            elif sequence > cursor + 1:
                break

        connection.execute(
            sa.text(
                """
                UPDATE agent_events
                SET event_stream_id = CAST(:stream_id AS uuid)
                WHERE agent_device_id = :device_id
                """
            ),
            {"stream_id": str(stream_id), "device_id": device_id},
        )
        connection.execute(
            sa.text(
                """
                UPDATE agent_devices
                SET current_event_stream_id = CAST(:stream_id AS uuid),
                    current_event_cursor = :cursor
                WHERE id = :device_id
                """
            ),
            {
                "stream_id": str(stream_id),
                "cursor": cursor,
                "device_id": device_id,
            },
        )

    op.alter_column("agent_events", "event_stream_id", nullable=False)
    op.drop_constraint(
        "uq_agent_events_device_sequence",
        "agent_events",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_agent_events_device_stream_sequence",
        "agent_events",
        ["agent_device_id", "event_stream_id", "monotonic_sequence"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_agent_events_device_stream_sequence",
        "agent_events",
        type_="unique",
    )
    op.get_bind().execute(
        sa.text(
            """
            WITH ranked AS (
                SELECT
                    id,
                    row_number() OVER (
                        PARTITION BY agent_device_id
                        ORDER BY received_at_cloud, id
                    ) AS sequence
                FROM agent_events
            )
            UPDATE agent_events AS event
            SET monotonic_sequence = ranked.sequence
            FROM ranked
            WHERE event.id = ranked.id
            """
        )
    )
    op.drop_column("agent_events", "event_stream_id")
    op.create_unique_constraint(
        "uq_agent_events_device_sequence",
        "agent_events",
        ["agent_device_id", "monotonic_sequence"],
    )
    op.drop_column("agent_devices", "current_event_cursor")
    op.drop_column("agent_devices", "current_event_stream_id")
