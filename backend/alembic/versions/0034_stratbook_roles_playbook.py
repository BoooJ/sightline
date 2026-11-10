"""stratbook : consignes par joueur, statut, catégorie (code couleur), liens ; mémo d'équipe (lexique, rappels, rôles)

Revision ID: 0034
Revises: 0033
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0034"
down_revision: Union[str, Sequence[str], None] = "0033"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("strats") as t:
        t.add_column(sa.Column("roles", sa.Text(), nullable=False, server_default="[]"))
        t.add_column(sa.Column("status", sa.String(16), nullable=True))
        t.add_column(sa.Column("category", sa.String(24), nullable=True))
        t.add_column(sa.Column("links", sa.Text(), nullable=False, server_default="[]"))
    op.create_table(
        "playbook_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("map_name", sa.String(64), nullable=True),
        sa.Column("side", sa.String(2), nullable=True),
        sa.Column("link", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_playbook_entries_kind", "playbook_entries", ["kind"])


def downgrade() -> None:
    op.drop_index("ix_playbook_entries_kind", table_name="playbook_entries")
    op.drop_table("playbook_entries")
    # DROP COLUMN natif : une copie de la table (recreate) déclencherait notes.strat_id ON DELETE SET NULL
    with op.batch_alter_table("strats", recreate="never") as t:
        t.drop_column("links")
        t.drop_column("category")
        t.drop_column("status")
        t.drop_column("roles")
