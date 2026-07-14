from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, IPvAnyAddress, field_validator, model_validator

from app.models.agent import AgentCommandState
from app.services.agent_auth import DEFAULT_AGENT_SCOPES, PAIRING_CODE_TTL_SECONDS, normalize_agent_scopes


class StrictAgentSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentDevicePairingCreate(StrictAgentSchema):
    name: str = Field(min_length=1, max_length=120)
    site_id: str | None = Field(default=None, max_length=64)
    scopes: list[str] = Field(default_factory=lambda: list(DEFAULT_AGENT_SCOPES), min_length=1)
    expires_in_seconds: int = Field(default=PAIRING_CODE_TTL_SECONDS, ge=60, le=1800)

    @field_validator("name", "site_id")
    @classmethod
    def strip_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("Must not be blank")
        return stripped

    @field_validator("scopes")
    @classmethod
    def validate_scopes(cls, value: list[str]) -> list[str]:
        return list(normalize_agent_scopes(value))


class AgentDeviceOut(BaseModel):
    id: UUID
    organization_id: int
    site_id: str | None
    name: str
    credential_version: int
    scopes: list[str]
    capabilities: list[str]
    version: str | None
    build: str | None
    channel: str
    connection_epoch: int
    last_seen_at: datetime | None
    paired_at: datetime | None
    revoked_at: datetime | None
    is_paired: bool
    is_revoked: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AgentPairingCodeCreated(StrictAgentSchema):
    device: AgentDeviceOut
    pairing_code: str
    expires_at: datetime


class AgentPrinterAssignmentUpdate(StrictAgentSchema):
    printer_ids: list[int] = Field(default_factory=list, max_length=1000)

    @field_validator("printer_ids")
    @classmethod
    def validate_printer_ids(cls, value: list[int]) -> list[int]:
        if any(isinstance(item, bool) or item < 1 for item in value):
            raise ValueError("printer_ids must contain positive integers")
        if len(set(value)) != len(value):
            raise ValueError("printer_ids must not contain duplicates")
        return value


class AgentPrinterAssignmentOut(StrictAgentSchema):
    device_id: UUID
    printer_ids: list[int]


class AgentPairRequest(StrictAgentSchema):
    pairing_code: str = Field(min_length=16, max_length=128)
    public_key: str = Field(min_length=44, max_length=44)
    capabilities: list[str] = Field(default_factory=list, max_length=64)

    @field_validator("public_key")
    @classmethod
    def validate_ed25519_public_key(cls, value: str) -> str:
        try:
            raw_key = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("public_key must be standard base64") from exc
        if len(raw_key) != 32:
            raise ValueError("public_key must contain exactly 32 Ed25519 bytes")
        if base64.b64encode(raw_key).decode("ascii") != value:
            raise ValueError("public_key must use canonical standard base64")
        return value


class AgentPairResult(StrictAgentSchema):
    device_id: UUID
    device_secret: str
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class AgentTokenRequest(StrictAgentSchema):
    device_id: UUID
    device_secret: str = Field(min_length=16, max_length=256)


class AgentTokenResponse(StrictAgentSchema):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class AgentCommandType(str, Enum):
    printer_status = "printer.status"
    printer_upload = "printer.upload"
    printer_start = "printer.start"
    printer_pause = "printer.pause"
    printer_resume = "printer.resume"
    printer_cancel = "printer.cancel"
    printer_snapshot = "printer.snapshot"
    printer_reconcile = "printer.reconcile"


class AgentCommandCreate(StrictAgentSchema):
    agent_device_id: UUID
    printer_id: int | None = Field(default=None, ge=1, strict=True)
    command_type: AgentCommandType
    payload: dict[str, Any] = Field(default_factory=dict)
    payload_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    idempotency_key: str = Field(min_length=1, max_length=128)
    deadline_at: datetime

    @field_validator("idempotency_key")
    @classmethod
    def strip_command_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Must not be blank")
        return stripped

    @field_validator("deadline_at")
    @classmethod
    def deadline_must_be_in_future(cls, value: datetime) -> datetime:
        normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        if normalized <= datetime.now(timezone.utc):
            raise ValueError("Command deadline must be in the future")
        return normalized


class AgentCommandOut(BaseModel):
    id: UUID
    organization_id: int
    agent_device_id: UUID
    printer_id: int | None
    command_type: AgentCommandType
    payload: dict[str, Any] = Field(validation_alias="payload_json")
    payload_sha256: str | None
    idempotency_key: str
    state: AgentCommandState
    attempt: int
    deadline_at: datetime
    lease_owner: str | None
    lease_expires_at: datetime | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AgentCommandPullRequest(StrictAgentSchema):
    limit: int = Field(default=10, ge=1, le=50, strict=True)
    lease_seconds: int = Field(default=30, ge=5, le=300, strict=True)


class AgentCommandLeaseOut(BaseModel):
    id: UUID
    agent_device_id: UUID
    printer_id: int | None
    command_type: AgentCommandType
    payload: dict[str, Any] = Field(validation_alias="payload_json")
    payload_sha256: str
    state: AgentCommandState
    attempt: int
    deadline_at: datetime
    lease_expires_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AgentCommandPullResponse(StrictAgentSchema):
    commands: list[AgentCommandLeaseOut]
    server_time: datetime


class AgentCommandAckState(str, Enum):
    accepted = "accepted"
    executing = "executing"
    delivered = "delivered"
    printer_ack = "printer_ack"
    terminal = "terminal"
    needs_reconcile = "needs_reconcile"
    failed = "failed"


class AgentCommandAckRequest(StrictAgentSchema):
    state: AgentCommandAckState
    attempt: int = Field(ge=1, strict=True)
    last_error: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def validate_error_for_state(self) -> "AgentCommandAckRequest":
        error_states = {AgentCommandAckState.needs_reconcile, AgentCommandAckState.failed}
        if self.last_error is not None:
            self.last_error = self.last_error.strip() or None
        if self.state in error_states and self.last_error is None:
            raise ValueError(f"last_error is required for state {self.state.value}")
        if self.state not in error_states and self.last_error is not None:
            raise ValueError(f"last_error is not allowed for state {self.state.value}")
        return self


class AgentCommandAckResponse(StrictAgentSchema):
    command_id: UUID
    state: AgentCommandState
    attempt: int
    updated_at: datetime


class AgentEventCreate(StrictAgentSchema):
    agent_device_id: UUID
    printer_id: int | None = Field(default=None, ge=1, strict=True)
    command_id: UUID | None = None
    monotonic_sequence: int = Field(ge=0, strict=True)
    event_type: str = Field(min_length=1, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at_device: datetime


class AgentEventOut(BaseModel):
    id: UUID
    organization_id: int
    agent_device_id: UUID
    printer_id: int | None
    command_id: UUID | None
    event_stream_id: UUID
    monotonic_sequence: int
    event_type: str
    payload: dict[str, Any] = Field(validation_alias="payload_json")
    occurred_at_device: datetime
    received_at_cloud: datetime

    model_config = ConfigDict(from_attributes=True)


class AgentEventIngestItem(StrictAgentSchema):
    sequence: int = Field(ge=1, strict=True)
    printer_id: int | None = Field(default=None, ge=1, strict=True)
    command_id: UUID | None = None
    event_type: str = Field(min_length=1, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at_device: datetime

    @field_validator("event_type")
    @classmethod
    def strip_event_type(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Must not be blank")
        return stripped

    @field_validator("occurred_at_device")
    @classmethod
    def normalize_occurred_at(cls, value: datetime) -> datetime:
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


class AgentEventBatchIngest(StrictAgentSchema):
    agent_device_id: UUID
    event_stream_id: UUID
    events: list[AgentEventIngestItem] = Field(min_length=1, max_length=100)


class AgentEventBatchResponse(StrictAgentSchema):
    accepted_count: int
    duplicate_count: int
    highest_accepted_sequence: int
    highest_contiguous_sequence: int


class PrintZplRequest(StrictAgentSchema):
    ip: IPvAnyAddress
    port: int = Field(default=9100, ge=1, le=65535)
    zpl: str = Field(min_length=1, max_length=1_000_000)


class AgentRuntimeMoonrakerPrinterOut(StrictAgentSchema):
    transport: Literal["moonraker"] = "moonraker"
    id: int
    name: str
    kind: Literal["snapmaker_u1", "other"]
    moonraker_url: str


class AgentRuntimeBambuPrinterOut(StrictAgentSchema):
    transport: Literal["bambu_lan"] = "bambu_lan"
    id: int
    name: str
    kind: Literal["bambu"] = "bambu"
    dev_id: str
    ip: str
    access_code: str
    model: str | None


AgentRuntimePrinterOut = Annotated[
    AgentRuntimeMoonrakerPrinterOut | AgentRuntimeBambuPrinterOut,
    Field(discriminator="transport"),
]


class AgentRuntimeConfigOut(StrictAgentSchema):
    device_id: UUID
    organization_id: int
    artifact_hosts: list[str]
    printers: list[AgentRuntimePrinterOut]


class TgCommandRequest(StrictAgentSchema):
    command: str = Field(min_length=1, max_length=64)
    chat_id: int
    args: list[str] = Field(default_factory=list, max_length=16)


class TgUsernameReport(StrictAgentSchema):
    username: str = Field(min_length=1, max_length=64)


class TgConfigOut(StrictAgentSchema):
    token: str | None
    username: str | None


class TgCommandOut(StrictAgentSchema):
    text: str
    parse_mode: Literal["Markdown"] | None


class AgentOkOut(StrictAgentSchema):
    ok: Literal[True] = True
