"""Keep manual task accounting distinct from accounting individual print runs."""
from alembic import op
import sqlalchemy as sa

revision = "0089"
down_revision = "0088"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("print_tasks", sa.Column("output_accounting_mode", sa.String(16), nullable=True))
    op.add_column("printers", sa.Column("last_clear_request_id", sa.String(36), nullable=True))


def downgrade():
    op.drop_column("printers", "last_clear_request_id")
    op.drop_column("print_tasks", "output_accounting_mode")
