"""scouting FACEIT : équipes suivies et démos rattachées aux matchs

Revision ID: 0014
Revises: 0013
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: Union[str, Sequence[str], None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "faceit_teams",
        sa.Column("team_id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("avatar", sa.String(512), nullable=False, server_default=""),
        sa.Column("steamids", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_table(
        "faceit_demos",
        sa.Column("demo_id", sa.Integer(), sa.ForeignKey("demos.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("match_id", sa.String(64), nullable=False, index=True),
    )


def downgrade() -> None:
    op.drop_table("faceit_demos")
    op.drop_table("faceit_teams")
