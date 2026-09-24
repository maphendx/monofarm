import enum
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship


from app.core.db import Base

if TYPE_CHECKING:
    from app.models.tag import Tag


class PrinterKind(str, enum.Enum):
    snapmaker_u1 = "snapmaker_u1"
    bambu = "bambu"
    anycubic = "anycubic"
    other = "other"


class Printer(Base):
    __tablename__ = "printers"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[PrinterKind] = mapped_column(Enum(PrinterKind), default=PrinterKind.other)

    # Manual state (used for U1 / non-API printers)
    manual_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    manual_job: Mapped[str | None] = mapped_column(String(255), nullable=True)
    manual_eta_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    manual_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Moonraker / Mainsail URL (for Snapmaker U1 and other Klipper-based printers)
    moonraker_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Bambu Lab Cloud linkage
    bambu_dev_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    bambu_access_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    bambu_dev_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    bambu_model: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # LAN-only MQTT mode (for older firmware without reliable cloud)
    bambu_lan_mode: Mapped[bool] = mapped_column(default=False, server_default="false")
    # Operator-selected material transport. None keeps legacy auto-detection.
    bambu_has_ams: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # Anycubic Kobra 3 / S1 local LAN linkage. User only enters anycubic_dev_ip;
    # the rest is discovered by the agent on first handshake and persisted back.
    anycubic_dev_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    anycubic_dev_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    anycubic_model_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    anycubic_model_name: Mapped[str | None] = mapped_column(String(64), nullable=True)

    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    # Array of {slot, color, type, brand?, filament_id?} dicts — what's loaded in each slot
    loaded_filaments: Mapped[list[Any]] = mapped_column(JSONB, default=list, server_default="[]")
    group_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("printer_groups.id", ondelete="SET NULL"), nullable=True, index=True
    )

    is_active: Mapped[bool] = mapped_column(default=True)
    # Operator-set "out of order" flag — excluded from tag matching / autoprint
    is_out_of_order: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Operator confirmed the finished print was removed from the bed. Purely a
    # display flag — never derived from or reset by live printer telemetry.
    # Cleared automatically once the printer starts a new print.
    bed_cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Retained when bed_cleared_at resets on a new run; never report an old run twice.
    last_cleared_history_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_clear_request_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # Operator dismissed an error. Purely a display flag — shows "paused"
    # instead of the error, regardless of live telemetry, until a new print starts.
    error_cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Klipper / hardware metadata (populated on first successful connect)
    firmware_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    power_watts: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Build volume in mm (used to filter compatible files)
    build_x: Mapped[int | None] = mapped_column(Integer, nullable=True)
    build_y: Mapped[int | None] = mapped_column(Integer, nullable=True)
    build_z: Mapped[int | None] = mapped_column(Integer, nullable=True)
    nozzle_diameter: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Build plate / surface, e.g. "Textured PEI", "Smooth PEI", "Cool Plate"
    bed_type: Mapped[str | None] = mapped_column(String(40), nullable=True)

    # Last file sent via monofarm (for reprint)
    last_gcode_file_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Chitu C1M PlateCycler AutoPrint configuration and persisted runtime state.
    autoprint_mode: Mapped[str] = mapped_column(String(20), default="off", server_default="off")
    bed_clear_pending: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    autoprint_plates_remaining: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    autoprint_cooldown_temp_c: Mapped[int] = mapped_column(Integer, default=40, server_default="40")
    autoprint_delay_seconds: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    autoprint_eject_last_plate: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    autoprint_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Tags
    tags: Mapped[list["Tag"]] = relationship(
        "Tag",
        secondary="printer_tags",
        back_populates="printers",
        lazy="selectin",
    )
