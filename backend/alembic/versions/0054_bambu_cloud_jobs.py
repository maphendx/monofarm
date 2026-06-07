"""bambu cloud jobs, org auth lifecycle, print history cloud linkage

Revision ID: 0054
Revises: 0053
Create Date: 2026-06-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0054"
down_revision = "0053"
branch_labels = None
depends_on = None


bambu_auth_type = sa.Enum("password", "email_code", "oauth_like", name="bambuauthtype")
bambu_cloud_job_status = sa.Enum(
    "queued", "validating", "creating_project", "uploading", "task_creating", "task_created",
    "acknowledged", "printing", "paused", "completed", "failed", "cancelled", "lost",
    name="bambucloudjobstatus",
)


def upgrade() -> None:
    bind = op.get_bind()

    # --- 1.1 Organization: Bambu auth lifecycle fields ---
    bambu_auth_type.create(bind, checkfirst=True)
    op.add_column("organizations", sa.Column("bambu_access_token", sa.String(2048), nullable=False, server_default=""))
    op.add_column("organizations", sa.Column("bambu_access_token_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("organizations", sa.Column("bambu_auth_type", bambu_auth_type, nullable=True))
    op.add_column("organizations", sa.Column("bambu_user_id", sa.String(64), nullable=False, server_default=""))
    op.add_column("organizations", sa.Column("bambu_last_auth_success_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("organizations", sa.Column("bambu_last_auth_error", sa.Text(), nullable=True))
    op.add_column("organizations", sa.Column("bambu_reauth_required", sa.Boolean(), nullable=False, server_default="false"))

    # --- 1.2 BambuCloudJob table (status enum auto-created with the table) ---
    op.create_table(
        "bambu_cloud_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("printer_id", sa.Integer(), sa.ForeignKey("printers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("gcode_file_id", sa.Integer(), sa.ForeignKey("gcode_files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("printer_bambu_dev_id", sa.String(64), nullable=True),
        sa.Column("file_name", sa.String(512), nullable=True),
        sa.Column("file_sha256", sa.String(64), nullable=True),
        sa.Column("file_size", sa.Integer(), nullable=True),
        sa.Column("region", sa.String(8), nullable=True),
        sa.Column("dispatch_mode", sa.String(16), nullable=False, server_default="cloud"),
        sa.Column("status", bambu_cloud_job_status, nullable=False, server_default="queued"),
        sa.Column("status_reason", sa.Text(), nullable=True),
        sa.Column("correlation_id", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("bambu_project_id", sa.String(64), nullable=True),
        sa.Column("bambu_model_id", sa.String(64), nullable=True),
        sa.Column("bambu_task_id", sa.String(64), nullable=True),
        sa.Column("request_payload_json", postgresql.JSONB(), nullable=True),
        sa.Column("project_response_json", postgresql.JSONB(), nullable=True),
        sa.Column("task_response_json", postgresql.JSONB(), nullable=True),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_details_json", postgresql.JSONB(), nullable=True),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("task_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("printer_ack_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_printing_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_mqtt_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_bambu_cloud_jobs_organization_id", "bambu_cloud_jobs", ["organization_id"])
    op.create_index("ix_bambu_cloud_jobs_printer_id", "bambu_cloud_jobs", ["printer_id"])
    op.create_index("ix_bambu_cloud_jobs_gcode_file_id", "bambu_cloud_jobs", ["gcode_file_id"])
    op.create_index("ix_bambu_cloud_jobs_org_created", "bambu_cloud_jobs", ["organization_id", "created_at"])
    op.create_index("ix_bambu_cloud_jobs_printer_status", "bambu_cloud_jobs", ["printer_id", "status"])
    op.create_index("ix_bambu_cloud_jobs_idempotency_key", "bambu_cloud_jobs", ["idempotency_key"], unique=True)
    op.create_index("ix_bambu_cloud_jobs_correlation_id", "bambu_cloud_jobs", ["correlation_id"], unique=True)
    op.create_index("ix_bambu_cloud_jobs_dev_id_status", "bambu_cloud_jobs", ["printer_bambu_dev_id", "status"])

    # --- 1.3 PrintHistory: cloud-print linkage fields ---
    op.add_column("print_history", sa.Column("result_reason", sa.String(255), nullable=True))
    op.add_column("print_history", sa.Column("source", sa.String(16), nullable=True))
    op.add_column("print_history", sa.Column(
        "created_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    op.add_column("print_history", sa.Column("file_sha256", sa.String(64), nullable=True))
    op.add_column("print_history", sa.Column(
        "bambu_cloud_job_id", sa.Integer(), sa.ForeignKey("bambu_cloud_jobs.id", ondelete="SET NULL"), nullable=True))
    op.add_column("print_history", sa.Column("bambu_task_id", sa.String(64), nullable=True))
    op.add_column("print_history", sa.Column("bambu_project_id", sa.String(64), nullable=True))
    op.create_index("ix_print_history_bambu_cloud_job_id", "print_history", ["bambu_cloud_job_id"])


def downgrade() -> None:
    op.drop_index("ix_print_history_bambu_cloud_job_id", table_name="print_history")
    op.drop_column("print_history", "bambu_project_id")
    op.drop_column("print_history", "bambu_task_id")
    op.drop_column("print_history", "bambu_cloud_job_id")
    op.drop_column("print_history", "file_sha256")
    op.drop_column("print_history", "created_by_user_id")
    op.drop_column("print_history", "source")
    op.drop_column("print_history", "result_reason")

    op.drop_index("ix_bambu_cloud_jobs_dev_id_status", table_name="bambu_cloud_jobs")
    op.drop_index("ix_bambu_cloud_jobs_correlation_id", table_name="bambu_cloud_jobs")
    op.drop_index("ix_bambu_cloud_jobs_idempotency_key", table_name="bambu_cloud_jobs")
    op.drop_index("ix_bambu_cloud_jobs_printer_status", table_name="bambu_cloud_jobs")
    op.drop_index("ix_bambu_cloud_jobs_org_created", table_name="bambu_cloud_jobs")
    op.drop_index("ix_bambu_cloud_jobs_gcode_file_id", table_name="bambu_cloud_jobs")
    op.drop_index("ix_bambu_cloud_jobs_printer_id", table_name="bambu_cloud_jobs")
    op.drop_index("ix_bambu_cloud_jobs_organization_id", table_name="bambu_cloud_jobs")
    op.drop_table("bambu_cloud_jobs")
    op.execute("DROP TYPE IF EXISTS bambucloudjobstatus")

    op.drop_column("organizations", "bambu_reauth_required")
    op.drop_column("organizations", "bambu_last_auth_error")
    op.drop_column("organizations", "bambu_last_auth_success_at")
    op.drop_column("organizations", "bambu_user_id")
    op.drop_column("organizations", "bambu_auth_type")
    op.drop_column("organizations", "bambu_access_token_expires_at")
    op.drop_column("organizations", "bambu_access_token")
    bambu_auth_type.drop(op.get_bind(), checkfirst=True)
