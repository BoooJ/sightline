"""organisation de la bibliothèque : dossiers, événements, étiquettes, date de jeu

Revision ID: 0006
Revises: 0005
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, Sequence[str], None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "match_labels",
        sa.Column("demo_id", sa.Integer(), sa.ForeignKey("demos.id", ondelete="CASCADE"), nullable=False),
        sa.Column("folder", sa.String(128), nullable=False, server_default=""),
        sa.Column("event", sa.String(128), nullable=False, server_default=""),
        sa.Column("tags", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("played_on", sa.Date(), nullable=True),
        sa.PrimaryKeyConstraint("demo_id"),
    )


def downgrade() -> None:
    op.drop_table("match_labels")
