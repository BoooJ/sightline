"""cartes probables d'un match FACEIT du calendrier (leurs cartes × les nôtres), recalculées par la synchro W6

Revision ID: 0031
Revises: 0030
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision: Union[str, Sequence[str], None] = "0030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("calendar_events") as t:
        t.add_column(sa.Column("map_odds", sa.Text(), nullable=True))
        t.add_column(sa.Column("map_odds_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("calendar_events") as t:
        t.drop_column("map_odds_at")
        t.drop_column("map_odds")
