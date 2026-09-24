import enum
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class WorkflowRunStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    waiting = "waiting"
    success = "success"
    failed = "failed"
    stopped = "stopped"


TERMINAL_RUN_STATUSES = (
    WorkflowRunStatus.success,
    WorkflowRunStatus.failed,
    WorkflowRunStatus.stopped,
)


class Workflow(Base):
    """Org-scoped automation graph: typed nodes + edges (n8n-style)."""

    __tablename__ = "workflows"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    graph: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WorkflowRun(Base):
    """One execution of a workflow.

    ``graph_snapshot`` pins the graph the run started with so edits never
    corrupt in-flight executions. ``node_states`` is the engine's resumable
    position: per-node status, outputs, error and wake_at for waiting nodes.
    """

    __tablename__ = "workflow_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[WorkflowRunStatus] = mapped_column(
        Enum(WorkflowRunStatus, name="workflow_run_status"),
        default=WorkflowRunStatus.pending,
        nullable=False,
        index=True,
    )
    trigger_type: Mapped[str] = mapped_column(String(60), nullable=False)
    trigger_payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    graph_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    variables: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    node_states: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
