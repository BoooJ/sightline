"""lieux des kills, vitesse des tirs, callouts personnalisés

Revision ID: 0010
Revises: 0009
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: Union[str, Sequence[str], None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("kills") as b:
        b.add_column(sa.Column("attacker_place", sa.String(64), nullable=True))
        b.add_column(sa.Column("victim_place", sa.String(64), nullable=True))
    with op.batch_alter_table("shots") as b:
        b.add_column(sa.Column("speed", sa.Float(), nullable=True))
    op.create_table(
        "callouts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("map_name", sa.String(64), nullable=False),
        sa.Column("place", sa.String(64), nullable=False),
        sa.Column("label", sa.String(64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("map_name", "place"),
    )


def downgrade() -> None:
    op.drop_table("callouts")
    with op.batch_alter_table("shots") as b:
        b.drop_column("speed")
    with op.batch_alter_table("kills") as b:
        b.drop_column("victim_place")
        b.drop_column("attacker_place")
