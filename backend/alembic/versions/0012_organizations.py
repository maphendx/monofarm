"""Add organizations table and organization_id to all tenant tables.

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-16
"""
from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Create organizations table
    op.create_table(
        "organizations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("slug", sa.String(60), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("simplyprint_api_key", sa.String(255), nullable=False, server_default=""),
        sa.Column("simplyprint_org_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("bambu_email", sa.String(255), nullable=False, server_default=""),
        sa.Column("bambu_password", sa.String(255), nullable=False, server_default=""),
        sa.Column("bambu_refresh_token", sa.String(512), nullable=False, server_default=""),
        sa.Column("bambu_region", sa.String(8), nullable=False, server_default=""),
    )
    op.create_index("ix_organizations_slug", "organizations", ["slug"], unique=True)

    # 2. Seed default organization from .env — we use raw SQL via get_bind()
    #    so we don't depend on ORM models (which may not match the old schema).
    conn = op.get_bind()

    # Pull env creds best-effort; fall back to empty strings.
    import os
    sp_key = os.environ.get("SIMPLYPRINT_API_KEY", "")
    sp_org = os.environ.get("SIMPLYPRINT_ORG_ID", "")
    bm_email = os.environ.get("BAMBU_EMAIL", "")
    bm_pw = os.environ.get("BAMBU_PASSWORD", "")
    bm_rt = os.environ.get("BAMBU_REFRESH_TOKEN", "")
    bm_rg = os.environ.get("BAMBU_REGION", "")

    conn.execute(
        sa.text(
            "INSERT INTO organizations (name, slug, simplyprint_api_key, simplyprint_org_id,"
            " bambu_email, bambu_password, bambu_refresh_token, bambu_region)"
            " VALUES (:name, :slug, :sp_key, :sp_org, :bm_email, :bm_pw, :bm_rt, :bm_rg)"
        ),
        {
            "name": "Default Farm",
            "slug": "default-farm",
            "sp_key": sp_key,
            "sp_org": sp_org,
            "bm_email": bm_email,
            "bm_pw": bm_pw,
            "bm_rt": bm_rt,
            "bm_rg": bm_rg,
        },
    )

    # Retrieve the default org id (always 1 on a fresh sequence, but let's be safe)
    result = conn.execute(sa.text("SELECT id FROM organizations WHERE slug = 'default-farm'"))
    default_org_id = result.scalar()

    # 3. Add nullable organization_id to each tenant table, backfill, then make NOT NULL

    tables = [
        "users",
        "printers",
        "print_tasks",
        "farm_tasks",
        "filaments",
        "filament_colors",
        "gcode_files",
        "printer_groups",
        "plan_entries",
    ]

    for table in tables:
        op.add_column(table, sa.Column("organization_id", sa.Integer(), nullable=True))
        conn.execute(
            sa.text(f"UPDATE {table} SET organization_id = :oid"),  # noqa: S608
            {"oid": default_org_id},
        )
        op.alter_column(table, "organization_id", nullable=False)
        op.create_index(
            f"ix_{table}_organization_id",
            table,
            ["organization_id"],
        )
        op.create_foreign_key(
            f"fk_{table}_organization_id",
            table,
            "organizations",
            ["organization_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    tables = [
        "users",
        "printers",
        "print_tasks",
        "farm_tasks",
        "filaments",
        "filament_colors",
        "gcode_files",
        "printer_groups",
        "plan_entries",
    ]
    for table in tables:
        op.drop_constraint(f"fk_{table}_organization_id", table, type_="foreignkey")
        op.drop_index(f"ix_{table}_organization_id", table_name=table)
        op.drop_column(table, "organization_id")

    op.drop_index("ix_organizations_slug", table_name="organizations")
    op.drop_table("organizations")
