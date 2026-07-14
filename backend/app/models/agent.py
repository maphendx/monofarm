from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AgentCommandState(str, enum.Enum):
    queued = "queued"
    leased = "leased"
    accepted = "accepted"
    executing = "executing"
    delivered = "delivered"
    printer_ack = "printer_ack"
    terminal = "terminal"
    needs_reconcile = "needs_reconcile"
    failed = "failed"


class AgentDevice(Base):
    __tablename__ = "agent_devices"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    site_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    public_key: Mapped[str | None] = mapped_column(Text, nullable=True)

    credential_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    credential_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    scopes: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")

    pairing_code_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    pairing_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    capabilities: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    build: Mapped[str | None] = mapped_column(String(64), nullable=True)
    channel: Mapped[str] = mapped_column(String(32), nullable=False, default="stable", server_default="stable")
    connection_epoch: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    current_event_stream_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        nullable=True,
    )
    current_event_cursor: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    @property
    def is_paired(self) -> bool:
        return self.paired_at is not None and self.credential_hash is not None

    @property
    def is_revoked(self) -> bool:
        return self.revoked_at is not None


class AgentCommand(Base):
    __tablename__ = "agent_commands"
    __table_args__ = (
        UniqueConstraint("organization_id", "idempotency_key", name="uq_agent_commands_org_idempotency"),
        CheckConstraint("attempt >= 0", name="ck_agent_commands_attempt_nonnegative"),
        Index("ix_agent_commands_device_state", "agent_device_id", "state"),
        Index("ix_agent_commands_org_created", "organization_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    agent_device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_devices.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    printer_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("printers.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    command_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    payload_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    state: Mapped[AgentCommandState] = mapped_column(
        Enum(AgentCommandState, name="agentcommandstate"),
        nullable=False,
        default=AgentCommandState.queued,
        server_default=AgentCommandState.queued.value,
    )
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    deadline_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class AgentEvent(Base):
    __tablename__ = "agent_events"
    __table_args__ = (
        UniqueConstraint(
            "agent_device_id",
            "event_stream_id",
            "monotonic_sequence",
            name="uq_agent_events_device_stream_sequence",
        ),
        CheckConstraint("monotonic_sequence >= 0", name="ck_agent_events_sequence_nonnegative"),
        Index("ix_agent_events_org_received", "organization_id", "received_at_cloud"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    agent_device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_devices.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    printer_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("printers.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    command_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_commands.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    event_stream_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    monotonic_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    occurred_at_device: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at_cloud: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
