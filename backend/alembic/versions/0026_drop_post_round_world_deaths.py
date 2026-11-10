"""retire les morts « world » enregistrées après la fin d'un round (joueurs retirés par le serveur en fin de match)

Ces lignes ne sont pas des morts de jeu : elles faussaient les morts des joueurs, les raisons de mort et les moments
décisifs de l'analyse. Le parseur ne les crée plus ; une ré-analyse de la démo ne les recrée donc pas.

Revision ID: 0026
Revises: 0025
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0026"
down_revision: Union[str, Sequence[str], None] = "0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DELETE FROM kills
        WHERE weapon = 'world'
          AND (attacker IS NULL OR attacker = victim)
          AND tick > (SELECT rounds.end_tick FROM rounds WHERE rounds.id = kills.round_id)
    """)


def downgrade() -> None:
    pass  # données dérivées de la démo : une ré-analyse les reconstruit si besoin
