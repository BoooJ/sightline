"""callouts placés à la main (position)

Revision ID: 0013
Revises: 0012
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: Union[str, Sequence[str], None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("callouts") as b:
        b.add_column(sa.Column("x", sa.Float(), nullable=True))
        b.add_column(sa.Column("y", sa.Float(), nullable=True))
        b.add_column(sa.Column("z", sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("callouts") as b:
        b.drop_column("z")
        b.drop_column("y")
        b.drop_column("x")
