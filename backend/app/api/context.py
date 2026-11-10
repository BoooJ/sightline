# backend/app/api/context.py
"""Résumé du contexte courant (barre de contexte commune) : combien de matchs, de cartes et de rounds les filtres
retiennent, et la liste de ces matchs (« Voir les matchs »)."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_session, lib_filters
from app.storage.labels import LibraryFilters
from app.storage.repository import list_matches

router = APIRouter(prefix="/api/context", tags=["context"])


@router.get("")
def context(map: str | None = None, lib: LibraryFilters = Depends(lib_filters), db: Session = Depends(get_session)):
    items = list_matches(db, map_name=map, lib=lib)
    return {"matches": len(items), "maps": len({m["map_name"] for m in items}), "rounds": sum(m["rounds_count"] for m in items),
            "official": sum(1 for m in items if m["kind"] == "official"),
            "practice": sum(1 for m in items if m["kind"] == "practice"), "list": items}
