"""vetos enregistrés (séquences pick / ban réelles, pour les statistiques et les prédictions du simulateur)

Revision ID: 0022
Revises: 0021
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: Union[str, Sequence[str], None] = "0021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "veto_records",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("team_a_id", sa.Integer(), sa.ForeignKey("teams.id", ondelete="CASCADE", name="fk_veto_team_a"), nullable=False, index=True),
        sa.Column("team_b_id", sa.Integer(), sa.ForeignKey("teams.id", ondelete="CASCADE", name="fk_veto_team_b"), nullable=False, index=True),
        sa.Column("format", sa.String(8), nullable=False, server_default="bo3"),
        sa.Column("steps", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("match_id", sa.Integer(), sa.ForeignKey("matches.id", ondelete="SET NULL", name="fk_veto_match"), nullable=True),
        sa.Column("played_on", sa.Date(), nullable=True),
        sa.Column("note", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL", name="fk_veto_created_by"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("veto_records")
