from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.printer import PrinterKind
from app.schemas.tag import TagOut


class FilamentSlot(BaseModel):
    """One filament slot in a printer (colour swatch + material label)."""
    slot: int
    color: str = "#888888"       # CSS hex colour
    color_name: str | None = None  # human label from the colour palette
    type: str = "PLA"            # material string, e.g. "PLA", "PETG", "ABS"
    brand: str | None = None
    filament_id: int | None = None  # optional link to Filament inventory row
    empty: bool = False          # no filament loaded in this slot
    unit_id: int | None = None   # AMS unit index (0, 1, 2, 3…); None = external


class PrinterCreate(BaseModel):
    name: str
    kind: PrinterKind = PrinterKind.other
    moonraker_url: str | None = None
    bambu_dev_id: str | None = None
    bambu_access_code: str | None = None
    bambu_dev_ip: str | None = None
    bambu_model: str | None = None
    bambu_lan_mode: bool = False
    bambu_has_ams: bool | None = None
    build_x: int | None = None
    build_y: int | None = None
    build_z: int | None = None
    nozzle_diameter: float | None = None
    bed_type: str | None = None


class PrinterUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    is_out_of_order: bool | None = None
    moonraker_url: str | None = None
    bambu_dev_id: str | None = None
    bambu_access_code: str | None = None
    bambu_dev_ip: str | None = None
    bambu_model: str | None = None
    bambu_lan_mode: bool | None = None
    bambu_has_ams: bool | None = None
    build_x: int | None = None
    build_y: int | None = None
    build_z: int | None = None
    nozzle_diameter: float | None = None
    bed_type: str | None = None


class PrinterManualUpdate(BaseModel):
    """Operator-set state for non-API printers (U1, etc)."""

    status: str | None = None  # free-form: 'idle', 'printing', 'maintenance', etc.
    job: str | None = None
    eta_minutes: int | None = None


class PrinterReorderItem(BaseModel):
    id: int
    sort_order: int


class PrinterGroupAssign(BaseModel):
    group_id: int | None  # None = remove from group


class AutoPrintQueueEntryOut(BaseModel):
    id: int
    title: str
    file_name: str | None = None
    runs_total: int
    runs_completed: int
    active_run_index: int | None = None
    is_active: bool = False


class AutoPrintStatusOut(BaseModel):
    enabled: bool
    plates_remaining: int
    active_job_status: str | None = None
    active_job_progress_pct: int | None = None
    error: str | None = None
    entries: list[AutoPrintQueueEntryOut] = Field(default_factory=list)


class PrinterOut(BaseModel):
    id: int
    name: str
    kind: PrinterKind
    moonraker_url: str | None = None
    bambu_dev_id: str | None = None
    bambu_dev_ip: str | None = None
    bambu_model: str | None = None
    bambu_lan_mode: bool = False
    bambu_has_ams: bool | None = None
    is_active: bool
    is_out_of_order: bool = False
    sort_order: int = 0
    group_id: int | None = None
    group_name: str | None = None
    loaded_filaments: list[FilamentSlot] = Field(default_factory=list)

    # Live / merged state for the dashboard
    state: str | None = None  # primary state ('printing', 'paused', 'idle', ...)
    state_stale: bool = False  # last known MQTT state while the printer is quiet
    flags: list[str] = []  # ['requires_attention', ...] from SimplyPrint
    job: str | None = None  # current job title
    eta_minutes: int | None = None
    updated_at: datetime | None = None
    source: str  # 'simplyprint' | 'moonraker' | 'bambu' | 'manual' | 'unknown'

    # Live telemetry extras (Moonraker + Bambu)
    progress_pct: int | None = None
    extruder_temp: float | None = None
    extruder_target: float | None = None
    bed_temp: float | None = None
    bed_target: float | None = None

    # Filament info for the file currently being printed
    current_filament_meta: dict | None = None

    # Error detail (Bambu HMS codes, Moonraker error string, etc.)
    error_msg: str | None = None

    # Multi-material system
    active_tray: int | None = None   # currently printing slot (0-based, 254=external)

    # U1 physical slot state — None for non-U1 printers; always 4 entries for U1
    slots: list[dict] | None = None

    # Klipper firmware metadata
    firmware_version: str | None = None
    power_watts: int | None = None
    firmware_features: dict | None = None  # {feature: bool|None} from firmware_matrix

    # Build volume
    build_x: int | None = None
    build_y: int | None = None
    build_z: int | None = None
    nozzle_diameter: float | None = None
    bed_type: str | None = None

    # Last file sent via monofarm (for reprint)
    last_gcode_file_id: int | None = None

    autoprint_mode: str = "off"
    autoprint_plates_remaining: int = 0
    autoprint_cooldown_temp_c: int = 40
    autoprint_delay_seconds: int = 0
    autoprint_eject_last_plate: bool = True
    autoprint_error: str | None = None

    # Tags
    tags: list[TagOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)
