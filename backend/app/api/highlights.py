# backend/app/api/highlights.py
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import big_json, get_session
from app.stats.cache import LibraryCache
from app.stats.highlights import TYPES, match_highlights, search_highlights

router = APIRouter(prefix="/api/highlights", tags=["highlights"])
_cache = LibraryCache(256)


@router.get("/types")
def types():
    return {k: v[0] for k, v in TYPES.items()}


@router.get("")
def highlights(type: str | None = None, map: str | None = None, player: str | None = None, match: int | None = None,
               limit: int = 300, db: Session = Depends(get_session)):
    """Moments forts de la bibliothèque, du plus marquant au moins marquant (type : liste séparée par des virgules)."""
    types_ = [t for t in (type or "").split(",") if t in TYPES] or None
    res = search_highlights(db, types_, map, player, match, cache=lambda m: _cache.get(db, ("hl", m.id), lambda: match_highlights(db, m)))
    return big_json({"total": len(res), "items": res[:max(1, min(limit, 2000))]})  # réponse volumineuse
