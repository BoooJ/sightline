"""calendrier synchronisé : événements venus d'une source (PRACC) et message de prép envoyé une fois

Revision ID: 0030
Revises: 0029
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: Union[str, Sequence[str], None] = "0029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("calendar_events") as t:
        t.add_column(sa.Column("source", sa.String(16), nullable=True))
        t.add_column(sa.Column("external_id", sa.String(128), nullable=True))
        t.add_column(sa.Column("announced_at", sa.DateTime(), nullable=True))
        t.create_unique_constraint("uq_calendar_events_source_external_id", ["source", "external_id"])


def downgrade() -> None:
    with op.batch_alter_table("calendar_events") as t:
        t.drop_constraint("uq_calendar_events_source_external_id", type_="unique")
        t.drop_column("announced_at")
        t.drop_column("external_id")
        t.drop_column("source")
