"""comms TeamSpeak : pseudo TeamSpeak des membres et sessions envoyées par le plugin

Revision ID: 0033
Revises: 0032
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: Union[str, Sequence[str], None] = "0032"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("users") as t:
        t.add_column(sa.Column("ts_nickname", sa.String(64), nullable=True))
    op.create_table(
        "comms_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="waiting"),
        sa.Column("recorder_steamid", sa.String(20), nullable=True),
        sa.Column("map_name", sa.String(64), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("folder", sa.Text(), nullable=False),
        sa.Column("match_id", sa.Integer(), sa.ForeignKey("matches.id", ondelete="SET NULL"), nullable=True),
        sa.Column("offset_s", sa.Float(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_comms_sessions_map_name", "comms_sessions", ["map_name"])


def downgrade() -> None:
    op.drop_index("ix_comms_sessions_map_name", table_name="comms_sessions")
    op.drop_table("comms_sessions")
    with op.batch_alter_table("users") as t:
        t.drop_column("ts_nickname")
