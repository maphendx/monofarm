"""add configurable PlateCycler AutoPrint state

Revision ID: 0074
Revises: 0073
Create Date: 2026-07-01
"""
import sqlalchemy as sa
from alembic import op

revision = "0074"
down_revision = "0073"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("printers", "autoprint_mode", type_=sa.String(length=20))
    op.add_column("printers", sa.Column("autoprint_plates_remaining", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("printers", sa.Column("autoprint_cooldown_temp_c", sa.Integer(), nullable=False, server_default="40"))
    op.add_column("printers", sa.Column("autoprint_delay_seconds", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("printers", sa.Column("autoprint_eject_last_plate", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("printers", sa.Column("autoprint_error", sa.Text(), nullable=True))

    op.add_column("plan_entries", sa.Column("runs_total", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("plan_entries", sa.Column("runs_completed", sa.Integer(), nullable=False, server_default="0"))

    op.add_column("bambu_cloud_jobs", sa.Column("plan_entry_id", sa.Integer(), nullable=True))
    op.add_column("bambu_cloud_jobs", sa.Column("autoprint_run_index", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_bambu_cloud_jobs_plan_entry_id",
        "bambu_cloud_jobs",
        "plan_entries",
        ["plan_entry_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_bambu_cloud_jobs_plan_entry_id", "bambu_cloud_jobs", ["plan_entry_id"])


def downgrade() -> None:
    op.drop_index("ix_bambu_cloud_jobs_plan_entry_id", table_name="bambu_cloud_jobs")
    op.drop_constraint("fk_bambu_cloud_jobs_plan_entry_id", "bambu_cloud_jobs", type_="foreignkey")
    op.drop_column("bambu_cloud_jobs", "autoprint_run_index")
    op.drop_column("bambu_cloud_jobs", "plan_entry_id")
    op.drop_column("plan_entries", "runs_completed")
    op.drop_column("plan_entries", "runs_total")
    op.drop_column("printers", "autoprint_error")
    op.drop_column("printers", "autoprint_eject_last_plate")
    op.drop_column("printers", "autoprint_delay_seconds")
    op.drop_column("printers", "autoprint_cooldown_temp_c")
    op.drop_column("printers", "autoprint_plates_remaining")
    op.execute("UPDATE printers SET autoprint_mode = 'off' WHERE length(autoprint_mode) > 10")
    op.alter_column("printers", "autoprint_mode", type_=sa.String(length=10))
