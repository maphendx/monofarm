"""Deterministic idempotency keys for material consumption ledgers.

Revision ID: 0094
Revises: 0093
"""
from alembic import op
import sqlalchemy as sa

revision = "0094"
down_revision = "0093"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Run-level spool deductions share one deterministic key per (run, slot).
    # Collapse any historical duplicates first (keep the earliest row).
    op.execute("""
        DELETE FROM filament_log a USING filament_log b
        WHERE a.id > b.id AND a.filament_id = b.filament_id AND a.reason = b.reason
          AND a.reason LIKE 'print_history:%'
    """)
    op.create_index(
        "uq_filament_log_run_deduction", "filament_log", ["filament_id", "reason"],
        unique=True,
        postgresql_where=sa.text("reason LIKE 'print_history:%'"),
    )

    # Warehouse material write-offs linked to prints/tasks are keyed the same
    # way; one ledger movement per physical consumption.
    op.execute("""
        DELETE FROM wh_movements a USING wh_movements b
        WHERE a.id > b.id AND a.reason = b.reason AND a.type = 'WRITE_OFF'
          AND (a.reason LIKE 'print_history:%' OR a.reason LIKE 'task:%')
    """)
    op.create_index(
        "uq_wh_movements_material_writeoff", "wh_movements", ["reason"],
        unique=True,
        postgresql_where=sa.text(
            "type = 'WRITE_OFF' AND (reason LIKE 'print_history:%' OR reason LIKE 'task:%')"
        ),
    )


def downgrade() -> None:
    op.drop_index("uq_wh_movements_material_writeoff", table_name="wh_movements")
    op.drop_index("uq_filament_log_run_deduction", table_name="filament_log")
