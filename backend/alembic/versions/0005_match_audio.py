"""pistes de communications vocales

Revision ID: 0005
Revises: 0004
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, Sequence[str], None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "match_audio",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("demo_id", sa.Integer(), sa.ForeignKey("demos.id", ondelete="CASCADE"), nullable=False),
        sa.Column("label", sa.String(64), nullable=False),
        sa.Column("file_name", sa.String(256), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("offset_s", sa.Float(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_match_audio_demo_id", "match_audio", ["demo_id"])


def downgrade() -> None:
    op.drop_table("match_audio")
