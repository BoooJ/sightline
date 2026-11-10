"""calendrier de l'équipe

Revision ID: 0011
Revises: 0010
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: Union[str, Sequence[str], None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "calendar_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="match"),
        sa.Column("opponent", sa.String(128), nullable=False, server_default=""),
        sa.Column("maps", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("starts_at", sa.DateTime(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("match_ids", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_calendar_events_starts_at", "calendar_events", ["starts_at"])


def downgrade() -> None:
    op.drop_index("ix_calendar_events_starts_at", "calendar_events")
    op.drop_table("calendar_events")
