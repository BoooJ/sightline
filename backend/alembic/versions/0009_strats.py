"""stratbook d'équipe

Revision ID: 0009
Revises: 0008
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: Union[str, Sequence[str], None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "strats",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("map_name", sa.String(64), nullable=False),
        sa.Column("side", sa.String(2), nullable=False),
        sa.Column("type", sa.String(16), nullable=False, server_default="other"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("tags", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("positions", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("grenades", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("shapes", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_strats_map_name", "strats", ["map_name"])


def downgrade() -> None:
    op.drop_table("strats")
