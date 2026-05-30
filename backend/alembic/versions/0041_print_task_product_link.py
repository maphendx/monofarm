"""link print tasks to warehouse products and batches

Revision ID: 0041
Revises: 0040
Create Date: 2026-05-29
"""
from alembic import op
import sqlalchemy as sa

revision = "0041"
down_revision = "0040"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("print_tasks", sa.Column("product_id", sa.Integer(), nullable=True))
    op.create_index("ix_print_tasks_product_id", "print_tasks", ["product_id"])
    op.create_foreign_key(
        "fk_print_tasks_product_id",
        "print_tasks", "wh_products",
        ["product_id"], ["id"],
        ondelete="SET NULL",
    )

    op.add_column("wh_batches", sa.Column("print_task_id", sa.Integer(), nullable=True))
    op.create_index("ix_wh_batches_print_task_id", "wh_batches", ["print_task_id"])
    op.create_foreign_key(
        "fk_wh_batches_print_task_id",
        "wh_batches", "print_tasks",
        ["print_task_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_wh_batches_print_task_id", "wh_batches", type_="foreignkey")
    op.drop_index("ix_wh_batches_print_task_id", table_name="wh_batches")
    op.drop_column("wh_batches", "print_task_id")

    op.drop_constraint("fk_print_tasks_product_id", "print_tasks", type_="foreignkey")
    op.drop_index("ix_print_tasks_product_id", table_name="print_tasks")
    op.drop_column("print_tasks", "product_id")
