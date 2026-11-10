"""Notre équipe dans un match : celle où jouent le plus de comptes du site liés à un joueur (Steam ID). Sert au résumé
Discord (W2) et au bilan de la semaine (W3), qui parlent de notre point de vue."""
from __future__ import annotations

from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.models import Match, User


def linked_steamids(db: Session) -> set[str]:
    return set(db.scalars(select(User.steamid).where(User.steamid.is_not(None))))


def our_team_id(db: Session, m: Match, linked: set[str] | None = None) -> int | None:
    """None sans compte lié dans le match, ou à égalité entre les deux équipes (on ne choisit pas)."""
    linked = linked_steamids(db) if linked is None else linked
    votes = Counter(mp.team_id for mp in m.players if mp.steamid in linked).most_common()
    if not votes or (len(votes) > 1 and votes[0][1] == votes[1][1]):
        return None
    return votes[0][0]


def our_team(db: Session, m: Match) -> str | None:
    """Nom de notre équipe dans ce match (Into The Horse, ou Platzhalter quand l'équipe joue sans tag)."""
    tid = our_team_id(db, m)
    if tid is None:
        return None
    return m.team_a.name if tid == m.team_a_id else m.team_b.name
