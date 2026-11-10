"""playlists : dossier, favori, étiquettes, auteur

Revision ID: 0020
Revises: 0019
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: Union[str, Sequence[str], None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("playlists") as b:
        b.add_column(sa.Column("folder", sa.String(128), nullable=False, server_default=""))
        b.add_column(sa.Column("favorite", sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column("tags", sa.Text(), nullable=False, server_default="[]"))
        b.add_column(sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL", name="fk_playlists_created_by"), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("playlists") as b:
        b.drop_column("created_by")
        b.drop_column("tags")
        b.drop_column("favorite")
        b.drop_column("folder")
