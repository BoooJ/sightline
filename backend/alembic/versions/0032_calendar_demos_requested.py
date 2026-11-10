"""démos de l'adversaire demandées d'office pour un match FACEIT du calendrier (une seule fois par match)

Revision ID: 0032
Revises: 0031
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0032"
down_revision: Union[str, Sequence[str], None] = "0031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("calendar_events") as t:
        t.add_column(sa.Column("demos_requested_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("calendar_events") as t:
        t.drop_column("demos_requested_at")
