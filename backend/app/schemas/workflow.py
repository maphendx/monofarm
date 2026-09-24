from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    graph: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = False


class WorkflowUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    graph: dict[str, Any] | None = None
    enabled: bool | None = None


class WorkflowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    graph: dict[str, Any]
    enabled: bool
    version: int
    created_at: datetime | None
    updated_at: datetime | None


class WorkflowRunCreate(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)


class WorkflowRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    workflow_id: int
    status: str
    trigger_type: str
    trigger_payload: dict[str, Any]
    graph_snapshot: dict[str, Any] = Field(default_factory=dict)
    node_states: dict[str, Any]
    variables: dict[str, Any]
    error: str | None
    created_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None


class WorkflowCatalog(BaseModel):
    nodes: list[dict[str, Any]]
    events: list[dict[str, Any]]
