"""shortlists de joueurs (scouting tool)

Revision ID: 0023
Revises: 0022
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: Union[str, Sequence[str], None] = "0022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "shortlists",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL", name="fk_shortlists_created_by"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_table(
        "shortlist_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("shortlist_id", sa.Integer(), sa.ForeignKey("shortlists.id", ondelete="CASCADE", name="fk_shortlist_items_list"), nullable=False, index=True),
        sa.Column("steamid", sa.String(32), nullable=False),
        sa.Column("name", sa.String(128), nullable=False, server_default=""),
        sa.Column("note", sa.String(300), nullable=False, server_default=""),
        sa.Column("added_at", sa.DateTime(), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("shortlist_items")
    op.drop_table("shortlists")
