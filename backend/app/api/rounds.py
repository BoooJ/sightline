# backend/app/api/rounds.py
import msgpack
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_session, lib_filters
from app.api.scouting import playbook, tactic_round_ids
from app.stats.rounds import QUICK, RoundFilters, search_rounds
from app.storage.labels import LibraryFilters, filtered_match_ids
from app.storage.models import Kill, Match, Round
from app.storage.repository import get_round_replay

router = APIRouter(prefix="/api/rounds", tags=["rounds"])


def _csv(v: str | None) -> list[str] | None:
    return [x for x in v.split(",") if x] if v else None


@router.get("/search")
def search(request: Request, map: str | None = None, team: int | None = None, opponent: int | None = None, side: str | None = None,
           buy: str | None = None, opp_buy: str | None = None, result: str | None = None, bomb: str | None = None,
           half: str | None = None, pistol: bool | None = None, match: int | None = None, limit: int = 500,
           quick: str | None = None, weapon: str | None = None, tactic: str | None = None,
           lib: LibraryFilters = Depends(lib_filters), db: Session = Depends(get_session)):
    side = side.upper() if side else None
    if side not in (None, "CT", "T") or result not in (None, "won", "lost")             or bomb not in (None, "planted", "none", "A", "B") or half not in (None, "first", "second", "ot"):
        raise HTTPException(400, "Filtre invalide")
    quick_l = _csv(quick)
    if quick_l and any(q not in QUICK for q in quick_l):
        raise HTTPException(400, "Préfiltre inconnu")
    ids = filtered_match_ids(db, lib, map)
    round_ids = None
    if tactic:
        # tactique détectée par le playbook de l'équipe : « t:execute », « t:execute:B », « ct:<placement> »
        if not team or not map:
            raise HTTPException(400, "Choisissez une équipe et une carte pour filtrer par tactique")
        round_ids, tactic_side = tactic_round_ids(playbook(request, team, map, db), tactic)
        side = side or tactic_side
    return search_rounds(db, RoundFilters(round_ids=round_ids, map=map, team=team, opponent=opponent, side=side, buy=_csv(buy),
                                          opp_buy=_csv(opp_buy), result=result, bomb=bomb, half=half, pistol=pistol,
                                          match=match, match_ids=ids, quick=quick_l, weapon=_csv(weapon),
                                          limit=max(1, min(limit, 2000))))


@router.get("/{round_id}/replay")
def replay(round_id: int, db: Session = Depends(get_session)):
    d = get_round_replay(db, round_id)
    if d is None:
        raise HTTPException(404, "Round introuvable")
    return Response(msgpack.packb(d, use_bin_type=True), media_type="application/msgpack",
                    headers={"Cache-Control": "private, max-age=3600"})


@router.get("/weapons")
def weapons(map: str | None = None, db: Session = Depends(get_session)):
    """Armes ayant tué dans la bibliothèque (pour les filtres), de la plus utilisée à la moins utilisée."""
    q = select(Kill.weapon, func.count()).group_by(Kill.weapon).order_by(func.count().desc())
    if map:
        q = q.join(Round, Round.id == Kill.round_id).join(Match, Match.id == Round.match_id).where(Match.map_name == map)
    return [{"weapon": w, "kills": n} for w, n in db.execute(q) if w]
