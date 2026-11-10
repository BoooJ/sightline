# backend/app/api/heatmaps.py
from collections import OrderedDict
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.stats.heatmaps import KINDS, HeatFilters, heatmap, players_on_map
from app.storage.models import Demo, Match

router = APIRouter(prefix="/api/heatmaps", tags=["heatmaps"])
# Les heatmaps de présence relisent toutes les images de replay de la carte : on garde les derniers résultats,
# invalidés dès que la bibliothèque change (nombre de matchs, dernier id, dernière date d'import).
_cache: OrderedDict = OrderedDict()
_lock = Lock()
_CACHE_SIZE = 64


@router.get("")
def get_heatmap(request: Request, map: str, kind: str = "presence", side: str | None = None, team: int | None = None,
                player: str | None = None, buy: str | None = None, t_from: float = 0.0, t_to: float | None = None,
                match: int | None = None, weapon: str | None = None, db: Session = Depends(get_session)):
    meta = request.app.state.maps.get(map)
    side = side.upper() if side else None
    if meta is None:
        raise HTTPException(404, "Carte inconnue")
    if kind not in KINDS or side not in (None, "CT", "T") or t_from < 0 or (t_to is not None and t_to <= t_from):
        raise HTTPException(400, "Filtre invalide")
    f = HeatFilters(map=map, kind=kind, side=side, team=team, player=player,
                    buy=sorted(b for b in buy.split(",") if b) if buy else None, t_from=t_from, t_to=t_to, match=match,
                    weapon=sorted(w for w in weapon.split(",") if w) if weapon else None)
    version = db.execute(select(func.count(Match.id), func.max(Match.id), func.max(Demo.imported_at))
                         .select_from(Match).join(Demo, Demo.id == Match.demo_id)).one()
    key = (repr(f), tuple(version))
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    res = heatmap(db, meta, f)
    with _lock:
        _cache[key] = res
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return res


@router.get("/players")
def players(map: str, db: Session = Depends(get_session)):
    return players_on_map(db, map)
