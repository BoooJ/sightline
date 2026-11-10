"""commentaires personnels et dessin joint

Revision ID: 0008
Revises: 0007
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: Union[str, Sequence[str], None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("comments") as b:
        b.add_column(sa.Column("private", sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column("shapes", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("comments") as b:
        b.drop_column("shapes")
        b.drop_column("private")
