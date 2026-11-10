# backend/app/api/pattern.py
"""Pattern Finder : un motif (conditions comme une tactique) + filtres de round → rounds correspondants."""
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.deps import get_session, lib_filters
from app.stats.tactics import clean_definition, find_patterns
from app.storage.labels import LibraryFilters, filtered_match_ids

router = APIRouter(tags=["pattern"])
BUYS = ("pistol", "eco", "semi", "force", "full")


@router.post("/api/pattern-finder/{team_id}")
def pattern_finder(request: Request, team_id: int, body: dict = Body(...), lib: LibraryFilters = Depends(lib_filters),
                   db: Session = Depends(get_session)):
    map_name = str(body.get("map", ""))
    side = str(body.get("side", "T")).upper()
    if side not in ("CT", "T") or map_name not in request.app.state.maps:
        raise HTTPException(400, "Camp ou carte invalide")
    raw = body.get("definition") or {}
    definition = {"conditions": []}
    if isinstance(raw, dict) and raw.get("conditions"):
        try:
            definition = clean_definition(raw)
        except (ValueError, TypeError) as e:
            raise HTTPException(400, str(e) or "Motif invalide")
    f = body.get("filters") or {}
    ints = lambda xs: [int(x) for x in (xs or []) if str(x).isdigit()]  # noqa: E731
    filters = {
        "buy": [b for b in (f.get("buy") or []) if b in BUYS] or None,
        "outcome": f.get("outcome") if f.get("outcome") in ("won", "lost") else None,
        "min_alive": int(f["min_alive"]) if str(f.get("min_alive", "")).isdigit() and int(f["min_alive"]) > 0 else None,
        "max_gap_s": float(f["max_gap_s"]) if isinstance(f.get("max_gap_s"), (int, float)) and f["max_gap_s"] > 0 else None,
        "include_tactics": ints(f.get("include_tactics")), "exclude_tactics": ints(f.get("exclude_tactics")),
        "negate": bool(f.get("negate")),
    }
    ids = filtered_match_ids(db, lib, map_name)
    return find_patterns(db, request.app.state.maps, team_id, map_name, side, ids, definition, filters)
