"""Physical spool lifecycle and material reservations.

Revision ID: 0095
Revises: 0094
"""
from alembic import op
import sqlalchemy as sa

revision = "0095"
down_revision = "0094"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Spool warehouse-side lifecycle: in_stock → empty → retired. "Loaded on a
    # printer" stays derived from PrinterSlot — never a second editable truth.
    op.add_column(
        "filaments",
        sa.Column("status", sa.String(16), nullable=False, server_default="in_stock"),
    )

    # Future demand for a spool from scheduled/dispatched jobs. Reservations
    # never change grams_remaining and never touch the warehouse ledger.
    op.create_table(
        "filament_reservations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("filament_id", sa.Integer(),
                  sa.ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("job_id", sa.Integer(),
                  sa.ForeignKey("bambu_cloud_jobs.id", ondelete="SET NULL"), nullable=True),
        # Deterministic reference for idempotency, e.g. "job:42:slot0".
        sa.Column("reference", sa.String(80), nullable=False),
        sa.Column("reserved_g", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_filament_reservations_organization_id", "filament_reservations", ["organization_id"])
    op.create_index("ix_filament_reservations_filament_id", "filament_reservations", ["filament_id"])
    op.create_index("ix_filament_reservations_job_id", "filament_reservations", ["job_id"])
    op.create_index(
        "uq_filament_reservations_reference", "filament_reservations",
        ["filament_id", "reference"], unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )

    # Organization-level pre-flight configuration (validation only — never the
    # actual accounting math).
    op.add_column(
        "organizations",
        sa.Column("filament_safety_margin_pct", sa.Integer(), nullable=False, server_default="5"),
    )
    op.add_column(
        "organizations",
        sa.Column("preflight_block_dispatch", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("organizations", "preflight_block_dispatch")
    op.drop_column("organizations", "filament_safety_margin_pct")
    op.drop_index("uq_filament_reservations_reference", table_name="filament_reservations")
    op.drop_index("ix_filament_reservations_job_id", table_name="filament_reservations")
    op.drop_index("ix_filament_reservations_filament_id", table_name="filament_reservations")
    op.drop_index("ix_filament_reservations_organization_id", table_name="filament_reservations")
    op.drop_table("filament_reservations")
    op.drop_column("filaments", "status")
