# backend/app/api/grenades.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import big_json, get_session
from app.stats.cache import LibraryCache
from app.stats.grenades import TYPES, search_grenades

router = APIRouter(prefix="/api/grenades", tags=["grenades"])
_cache = LibraryCache(64, name="grenades")  # une recherche parcourt toutes les grenades de la carte : gardée


@router.get("")
def grenades(map: str, type: str | None = None, side: str | None = None, team: int | None = None,
             player: str | None = None, match: int | None = None, lineups: bool = True, throws: bool = True,
             db: Session = Depends(get_session)):
    types = [t for t in type.split(",") if t] if type else None
    side = side.upper() if side else None
    if side not in (None, "CT", "T") or (types and any(t not in TYPES for t in types)):
        raise HTTPException(400, "Filtre invalide")
    res = _cache.get(db, ("grenades", map, tuple(types or ()), side, team, player, match),
                     lambda: search_grenades(db, map, types, side, team, player, match))
    if not lineups:  # l'interface regroupe elle-même (filtres instantanés) : inutile de doubler la réponse
        res = {**res, "lineups": []}
    if not throws:  # app mobile : seulement les lineups regroupés (sinon jusqu'à 3 000 lancers et leurs trajectoires)
        res = {**res, "throws": []}
    return big_json(res)  # réponse volumineuse : sérialisée directement (sans la relecture générique de FastAPI)
