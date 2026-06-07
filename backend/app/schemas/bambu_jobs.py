from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, computed_field

from app.models.bambu_cloud_job import BambuCloudJobStatus
from app.services.bambu_errors import is_retryable, to_user_message

_TERMINAL_STATUSES = {
    BambuCloudJobStatus.completed,
    BambuCloudJobStatus.failed,
    BambuCloudJobStatus.cancelled,
    BambuCloudJobStatus.lost,
}


class BambuCloudJobOut(BaseModel):
    id: int
    organization_id: int
    printer_id: int
    printer_name: str | None = None
    printer_model: str | None = None
    gcode_file_id: int | None = None
    created_by_user_id: int | None = None
    printer_bambu_dev_id: str | None = None
    file_name: str | None = None
    file_sha256: str | None = None
    file_size: int | None = None
    region: str | None = None
    dispatch_mode: str
    status: BambuCloudJobStatus
    status_reason: str | None = None
    correlation_id: str
    idempotency_key: str
    bambu_project_id: str | None = None
    bambu_model_id: str | None = None
    bambu_task_id: str | None = None
    request_payload_json: dict[str, Any] | None = None
    project_response_json: dict[str, Any] | None = None
    task_response_json: dict[str, Any] | None = None
    error_code: str | None = None
    error_details_json: dict[str, Any] | None = None
    retry_count: int
    progress_pct: int | None = None
    eta_minutes: int | None = None
    error_msg: str | None = None
    created_at: datetime
    updated_at: datetime | None = None
    uploaded_at: datetime | None = None
    task_created_at: datetime | None = None
    printer_ack_at: datetime | None = None
    started_printing_at: datetime | None = None
    completed_at: datetime | None = None
    failed_at: datetime | None = None
    last_mqtt_at: datetime | None = None

    model_config = {"from_attributes": True}

    @computed_field
    @property
    def is_terminal(self) -> bool:
        return self.status in _TERMINAL_STATUSES

    @computed_field
    @property
    def is_active(self) -> bool:
        return self.status not in _TERMINAL_STATUSES

    @computed_field
    @property
    def can_retry(self) -> bool:
        if self.status != BambuCloudJobStatus.failed:
            return False
        details = self.error_details_json or {}
        return is_retryable(self.error_code) or bool(details.get("retryable"))

    @computed_field
    @property
    def error_message(self) -> str | None:
        if not self.error_code:
            return None
        return to_user_message(self.error_code)


class BambuJobListOut(BaseModel):
    items: list[BambuCloudJobOut]
    total: int
    limit: int
    offset: int


class BambuRetryResult(BaseModel):
    ok: bool
    job: BambuCloudJobOut
    message: str


class BambuHealthAuth(BaseModel):
    configured: bool
    reauth_required: bool
    auth_type: str | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    access_token_expires_at: datetime | None = None
    region: str | None = None


class BambuHealthMqtt(BaseModel):
    connected: bool
    last_message_at: datetime | None = None
    tracked_devices: list[str] = Field(default_factory=list)


class BambuHealthPrinters(BaseModel):
    total: int
    bambu_cloud: int
    online: int
    offline: int


class BambuHealthJobs(BaseModel):
    active: int
    stuck_or_lost: int
    recent_failures: int
    queued: int


class BambuHealthOut(BaseModel):
    auth: BambuHealthAuth
    mqtt: BambuHealthMqtt
    printers: BambuHealthPrinters
    jobs: BambuHealthJobs


class BambuQueuedResult(BaseModel):
    ok: bool = True
    printer_id: int | None = None
    printer_name: str
    dispatch_mode: str = "cloud"
    message: str
    job_id: int
    status: BambuCloudJobStatus
    correlation_id: str
