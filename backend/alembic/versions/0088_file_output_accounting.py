"""Production accounting: gcode file → products per run, frozen run plan, run receipts.

Revision ID: 0088
Revises: 0087
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0088"
down_revision = "0087"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "gcode_file_outputs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "gcode_file_id", sa.Integer(),
            sa.ForeignKey("gcode_files.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "product_id", sa.Integer(),
            sa.ForeignKey("wh_products.id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("qty_per_run", sa.Integer(), nullable=False),
        sa.Column("plate", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_gcode_file_outputs_organization_id", "gcode_file_outputs", ["organization_id"])
    op.create_index("ix_gcode_file_outputs_gcode_file_id", "gcode_file_outputs", ["gcode_file_id"])
    op.create_index("ix_gcode_file_outputs_product_id", "gcode_file_outputs", ["product_id"])
    op.create_index(
        "uq_gcode_file_outputs", "gcode_file_outputs", ["gcode_file_id", "product_id", "plate"],
        unique=True, postgresql_nulls_not_distinct=True,
    )

    op.add_column(
        "gcode_files",
        sa.Column(
            "output_warehouse_id", sa.Integer(),
            sa.ForeignKey("wh_warehouses.id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.add_column("bambu_cloud_jobs", sa.Column("output_plan", postgresql.JSONB(), nullable=True))
    op.add_column(
        "wh_movements",
        sa.Column(
            "print_history_id", sa.Integer(),
            sa.ForeignKey("print_history.id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.create_index("ix_wh_movements_print_history_id", "wh_movements", ["print_history_id"])
    # Idempotency floor: one production receipt per (run, product) no matter how
    # many operator confirmations or retried HTTP requests produce it.
    # Enum labels store the Python member names (PRODUCTION_IN), see 0002.
    op.create_index(
        "uq_wh_movements_run_receipt", "wh_movements", ["print_history_id", "product_id"],
        unique=True,
        postgresql_where=sa.text("type = 'PRODUCTION_IN' AND print_history_id IS NOT NULL"),
    )

    op.add_column(
        "print_tasks",
        sa.Column(
            "output_accounted_from_runs", sa.Boolean(), nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("print_tasks", "output_accounted_from_runs")
    op.drop_index("uq_wh_movements_run_receipt", table_name="wh_movements")
    op.drop_index("ix_wh_movements_print_history_id", table_name="wh_movements")
    op.drop_column("wh_movements", "print_history_id")
    op.drop_column("bambu_cloud_jobs", "output_plan")
    op.drop_column("gcode_files", "output_warehouse_id")
    op.drop_index("uq_gcode_file_outputs", table_name="gcode_file_outputs")
    op.drop_index("ix_gcode_file_outputs_product_id", table_name="gcode_file_outputs")
    op.drop_index("ix_gcode_file_outputs_gcode_file_id", table_name="gcode_file_outputs")
    op.drop_index("ix_gcode_file_outputs_organization_id", table_name="gcode_file_outputs")
    op.drop_table("gcode_file_outputs")
