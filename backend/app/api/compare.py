# backend/app/api/compare.py
"""Référence de comparaison pour la barre de contexte : `mode=teams` (équipes de la bibliothèque, fenêtre en mois)
ou `mode=self` (forme passée du joueur). Les filtres de la page (camp, carte, économie, sélection de matchs) sont
repris tels quels pour que la référence soit comparable."""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.deps import get_session, lib_filters, lib_key
from app.stats.cache import LibraryCache
from app.stats.compare import baseline_players, baseline_self
from app.stats.compute import ECONS, OPP_ECONS
from app.stats.team_stats import team_baseline
from app.storage.labels import LibraryFilters, filtered_match_ids

router = APIRouter(prefix="/api/compare", tags=["compare"])
_cache = LibraryCache(64)
MAX_TEAMS = 5


@router.get("")
def compare(request: Request, mode: str = "teams", cmp_teams: str | None = None, cmp_months: int | None = 3, steamid: str | None = None,
            n: int | None = None, target: str | None = None, side: str | None = None, map: str | None = None, econ: str | None = None,
            opp_econ: str | None = None, lib: LibraryFilters = Depends(lib_filters), db: Session = Depends(get_session)):
    """`target=team` : référence d'équipe (taux de rounds, pistols, ouvertures, trades, 4v5 / 5v4, FAR, UDR) ; sinon
    référence joueur."""
    side = side.upper() if side else None
    if side not in (None, "CT", "T") or econ not in (None, *ECONS) or opp_econ not in (None, *OPP_ECONS):
        raise HTTPException(400, "Filtre invalide")
    if mode == "teams":
        try:
            teams = sorted({int(t) for t in (cmp_teams or "").split(",") if t})[:MAX_TEAMS]
        except ValueError:
            raise HTTPException(400, "cmp_teams : identifiants d'équipes séparés par des virgules")
        if not teams:
            return {"mode": "teams", "teams": [], "months": cmp_months, "rounds": 0, "players": 0, "stats": {}}
        if target == "team":
            key = ("cmp-team-stats", tuple(teams), cmp_months, side, map, econ, opp_econ, lib.kind)
            return _cache.get(db, key, lambda: team_baseline(db, request.app.state.maps, teams, cmp_months, side, map, econ, opp_econ, lib.kind))
        key = ("cmp-teams", tuple(teams), cmp_months, side, map, econ, opp_econ, lib.kind)
        return _cache.get(db, key, lambda: baseline_players(db, teams, cmp_months, side, map, econ, opp_econ, lib.kind))
    if mode == "self":
        if not steamid:
            raise HTTPException(400, "steamid requis en mode self")
        key = ("cmp-self", steamid, n, side, map, econ, opp_econ, lib_key(lib))
        return _cache.get(db, key, lambda: baseline_self(db, steamid, filtered_match_ids(db, lib, map), side, map, econ, opp_econ, n))
    raise HTTPException(400, "mode : teams ou self")
