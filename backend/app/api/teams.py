# backend/app/api/teams.py
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.deps import get_session, lib_filters, lib_key
from app.stats.cache import LibraryCache
from app.stats.compute import ECONS, OPP_ECONS
from app.stats.positions import player_positions
from app.stats.rounds import teams_list
from app.stats.team_stats import _team_matches, team_stats
from app.storage.labels import LibraryFilters, filtered_match_ids

router = APIRouter(prefix="/api/teams", tags=["teams"])
_cache = LibraryCache(32)


def _check(side: str | None, econ: str | None, opp_econ: str | None) -> tuple:
    side = side.upper() if side else None
    if side not in (None, "CT", "T") or econ not in (None, *ECONS) or opp_econ not in (None, *OPP_ECONS):
        raise HTTPException(400, "Filtre invalide")
    return side, econ, opp_econ


@router.get("")
def teams(db: Session = Depends(get_session)):
    return teams_list(db)


@router.get("/{team_id}/stats")
def stats(request: Request, team_id: int, side: str | None = None, map: str | None = None, econ: str | None = None,
          opp_econ: str | None = None, lib: LibraryFilters = Depends(lib_filters), db: Session = Depends(get_session)):
    """Stats d'équipe (vue d'ensemble, par carte et par camp, joueurs du roster, ouvertures, clutchs) sur la
    sélection de la barre de contexte."""
    side, econ, opp_econ = _check(side, econ, opp_econ)
    ids = filtered_match_ids(db, lib, map)
    key = ("team-stats", team_id, side, map, econ, opp_econ, lib_key(lib))
    out = _cache.get(db, key, lambda: team_stats(db, request.app.state.maps, team_id, ids, side, map, econ, opp_econ))
    if out is None:
        raise HTTPException(404, "Équipe introuvable")
    return out


@router.get("/{team_id}/positions")
def positions(request: Request, team_id: int, map: str | None = None, lib: LibraryFilters = Depends(lib_filters),
              db: Session = Depends(get_session)):
    """Postes de départ de chaque joueur de l'équipe (lieu dominant, rôle EDGE, répartition des lieux) par camp."""
    ids = filtered_match_ids(db, lib, map)
    matches = _team_matches(db, team_id, ids, map)
    mids = {m.id for m in matches}
    key = ("team-positions", team_id, map, tuple(sorted(mids)))

    def compute():
        pos = player_positions(db, request.app.state.maps, map, mids)
        names = {mp.steamid: mp.name_in_match for m in matches for mp in m.players if mp.team_id == team_id}
        return [{"steamid": sid, "name": names[sid], "T": pos.get(sid, {}).get("T"), "CT": pos.get(sid, {}).get("CT"),
                 "maps": pos.get(sid, {}).get("maps", {})} for sid in names]
    return _cache.get(db, key, compute)
