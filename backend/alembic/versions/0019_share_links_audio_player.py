"""liens de partage publics du replay ; piste vocale rattachée à un joueur

Revision ID: 0019
Revises: 0018
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: Union[str, Sequence[str], None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("match_audio") as b:
        b.add_column(sa.Column("steamid", sa.String(32), nullable=True))
    op.create_table(
        "share_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token", sa.String(48), nullable=False, unique=True),
        sa.Column("match_id", sa.Integer(), sa.ForeignKey("matches.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("tick", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("layers", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("share_links")
    with op.batch_alter_table("match_audio") as b:
        b.drop_column("steamid")
