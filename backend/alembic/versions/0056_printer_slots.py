"""printer_slots and slot_events tables; backfill from loaded_filaments

Revision ID: 0056
Revises: 0055
Create Date: 2026-06-09
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0056"
down_revision = "0055"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "printer_slots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("printer_id", sa.Integer(), sa.ForeignKey("printers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("slot_index", sa.Integer(), nullable=False),
        sa.Column("filament_id", sa.Integer(), sa.ForeignKey("filaments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("material", sa.String(40), nullable=True),
        sa.Column("color", sa.String(40), nullable=True),
        sa.Column("hex_color", sa.String(7), nullable=True),
        sa.Column("brand", sa.String(80), nullable=True),
        sa.Column("grams_at_load", sa.Integer(), nullable=True),
        sa.Column("state", sa.String(16), nullable=False, server_default="empty"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("ix_printer_slots_printer_id", "printer_slots", ["printer_id"])
    op.create_unique_constraint("uq_printer_slot", "printer_slots", ["printer_id", "slot_index"])

    op.create_table(
        "slot_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("printer_id", sa.Integer(), sa.ForeignKey("printers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("slot_index", sa.Integer(), nullable=False),
        sa.Column("event", sa.String(20), nullable=False),
        sa.Column("filament_id", sa.Integer(), sa.ForeignKey("filaments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("grams_delta", sa.Integer(), nullable=True),
        sa.Column("task_id", sa.Integer(), sa.ForeignKey("print_tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("meta", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("ix_slot_events_printer_id", "slot_events", ["printer_id"])

    # Backfill PrinterSlot rows from printers.loaded_filaments JSONB.
    # Each element: {slot, color, type, brand?, filament_id?}
    # slot is 0-based (matches slot_index).
    op.execute("""
        INSERT INTO printer_slots (printer_id, slot_index, filament_id, material, color, brand, state)
        SELECT
            p.id,
            (elem->>'slot')::int,
            NULLIF(elem->>'filament_id', '')::int,
            elem->>'type',
            elem->>'color',
            elem->>'brand',
            CASE WHEN elem->>'filament_id' IS NOT NULL AND elem->>'filament_id' != '' THEN 'loaded'
                 WHEN elem->>'color' IS NOT NULL AND elem->>'color' != '' THEN 'loaded'
                 ELSE 'empty' END
        FROM printers p,
             jsonb_array_elements(
                 CASE WHEN jsonb_typeof(p.loaded_filaments) = 'array' THEN p.loaded_filaments
                      ELSE '[]'::jsonb END
             ) AS elem
        WHERE p.loaded_filaments IS NOT NULL
          AND jsonb_array_length(
                  CASE WHEN jsonb_typeof(p.loaded_filaments) = 'array' THEN p.loaded_filaments
                       ELSE '[]'::jsonb END
              ) > 0
        ON CONFLICT ON CONSTRAINT uq_printer_slot DO NOTHING
    """)


def downgrade() -> None:
    op.drop_table("slot_events")
    op.drop_table("printer_slots")
