"""add cell movements audit log + clamp existing cell stock to ledger

Revision ID: 0039
Revises: 0038
Create Date: 2026-05-28

"""
from alembic import op
import sqlalchemy as sa

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wh_cell_movements",
        sa.Column("id",              sa.Integer(),      primary_key=True),
        sa.Column("organization_id", sa.Integer(),      sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("product_id",      sa.Integer(),      sa.ForeignKey("wh_products.id",   ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("cell_from_id",    sa.Integer(),      sa.ForeignKey("wh_cells.id",      ondelete="SET NULL"), nullable=True),
        sa.Column("cell_to_id",      sa.Integer(),      sa.ForeignKey("wh_cells.id",      ondelete="SET NULL"), nullable=True),
        sa.Column("quantity",        sa.Numeric(12, 4), nullable=False),
        sa.Column("kind",            sa.Enum("putaway", "relocate", "pick", "adjust", name="cellmovekind"), nullable=False, index=True),
        sa.Column("movement_id",     sa.Integer(),      sa.ForeignKey("wh_movements.id",  ondelete="SET NULL"), nullable=True),
        sa.Column("created_by_id",   sa.Integer(),      sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at",      sa.DateTime(timezone=True), server_default=sa.func.now(), index=True),
    )

    # Data hygiene: existing cell stock could exceed the ledger total because the
    # old design let cells be set freely. Clamp each cell down so that, per
    # (product, warehouse), sum(cell_stock) <= stock_entries.quantity. Excess is
    # removed from the highest-id (most recently touched) cells first.
    op.execute(
        """
        WITH wh_assigned AS (
            SELECT cs.id            AS cs_id,
                   cs.product_id    AS product_id,
                   z.warehouse_id   AS warehouse_id,
                   cs.quantity      AS quantity,
                   SUM(cs.quantity) OVER (
                       PARTITION BY cs.product_id, z.warehouse_id
                       ORDER BY cs.id DESC
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   )                AS running_from_top
            FROM wh_cell_stock cs
            JOIN wh_cells  c ON c.id = cs.cell_id
            JOIN wh_zones  z ON z.id = c.zone_id
        ),
        clamped AS (
            SELECT wa.cs_id,
                   GREATEST(
                       0,
                       LEAST(
                           wa.quantity,
                           COALESCE(se.quantity, 0)
                               - (wa.running_from_top - wa.quantity)
                       )
                   ) AS new_qty
            FROM wh_assigned wa
            LEFT JOIN wh_stock_entries se
                   ON se.product_id = wa.product_id
                  AND se.warehouse_id = wa.warehouse_id
        )
        UPDATE wh_cell_stock cs
        SET quantity = clamped.new_qty
        FROM clamped
        WHERE cs.id = clamped.cs_id
          AND cs.quantity <> clamped.new_qty
        """
    )
    op.execute("DELETE FROM wh_cell_stock WHERE quantity <= 0")


def downgrade() -> None:
    op.drop_table("wh_cell_movements")
    op.execute("DROP TYPE IF EXISTS cellmovekind")
