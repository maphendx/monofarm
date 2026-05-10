"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-05-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


user_role = sa.Enum("admin", "operator", "manager", name="userrole")
printer_kind = sa.Enum("simplyprint", "snapmaker_u1", "other", name="printerkind")
print_task_status = sa.Enum("queued", "in_progress", "done", "cancelled", name="printtaskstatus")
farm_task_status = sa.Enum("todo", "in_progress", "done", name="farmtaskstatus")


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False, unique=True, index=True),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False, server_default=""),
        sa.Column("role", user_role, nullable=False, server_default="operator"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "printers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("kind", printer_kind, nullable=False, server_default="simplyprint"),
        sa.Column("sp_printer_id", sa.String(length=64), nullable=True, index=True),
        sa.Column("manual_status", sa.String(length=40), nullable=True),
        sa.Column("manual_job", sa.String(length=255), nullable=True),
        sa.Column("manual_eta_minutes", sa.Integer(), nullable=True),
        sa.Column("manual_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "print_tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("filament_type", sa.String(length=40), nullable=True),
        sa.Column("filament_color", sa.String(length=40), nullable=True),
        sa.Column("estimated_minutes", sa.Integer(), nullable=True),
        sa.Column("deadline", sa.Date(), nullable=True),
        sa.Column("file_ref", sa.String(length=500), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("status", print_task_status, nullable=False, server_default="queued"),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "farm_tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", farm_task_status, nullable=False, server_default="todo"),
        sa.Column("deadline", sa.Date(), nullable=True),
        sa.Column("assignee_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "plan_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("plan_date", sa.Date(), nullable=False, index=True),
        sa.Column("printer_id", sa.Integer(), sa.ForeignKey("printers.id"), nullable=False),
        sa.Column("task_id", sa.Integer(), sa.ForeignKey("print_tasks.id"), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "filaments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("material", sa.String(length=40), nullable=False),
        sa.Column("color", sa.String(length=40), nullable=False),
        sa.Column("brand", sa.String(length=80), nullable=True),
        sa.Column("grams_remaining", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("min_grams", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("filaments")
    op.drop_table("plan_entries")
    op.drop_table("farm_tasks")
    op.drop_table("print_tasks")
    op.drop_table("printers")
    op.drop_table("users")
    farm_task_status.drop(op.get_bind(), checkfirst=True)
    print_task_status.drop(op.get_bind(), checkfirst=True)
    printer_kind.drop(op.get_bind(), checkfirst=True)
    user_role.drop(op.get_bind(), checkfirst=True)
