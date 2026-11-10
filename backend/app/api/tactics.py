# backend/app/api/tactics.py
"""Tactiques du playbook (CRUD) et détection par équipe / carte / camp."""
import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_session, lib_filters, lib_key
from app.auth.core import require_user
from app.stats.cache import LibraryCache
from app.stats.tactics import CATEGORIES, CATEGORY_LABELS, clean_definition, detect_playbook, tactic_dict
from app.storage.labels import LibraryFilters, filtered_match_ids
from app.storage.models import Tactic, User

router = APIRouter(tags=["tactics"])
_cache = LibraryCache(32)
_version = [0]  # incrémenté à chaque modification : la détection en cache ne survit pas à un changement de tactique


def _bump() -> None:
    _version[0] += 1


def _clean(body: dict, partial: bool) -> dict:
    out: dict = {}
    if "name" in body or not partial:
        name = str(body.get("name", "")).strip()
        if not name:
            raise HTTPException(400, "Nom requis")
        out["name"] = name[:120]
    if "map" in body or not partial:
        out["map_name"] = str(body.get("map", "")).strip()[:64]
        if not out["map_name"]:
            raise HTTPException(400, "Carte requise")
    if "side" in body or not partial:
        if body.get("side") not in ("CT", "T"):
            raise HTTPException(400, "Camp invalide (CT ou T)")
        out["side"] = body["side"]
    if "category" in body or not partial:
        cat = str(body.get("category") or "mid_round").strip()[:32]
        out["category"] = cat if cat in CATEGORY_LABELS else cat or "mid_round"
    if "tags" in body:
        tags = body["tags"] if isinstance(body["tags"], list) else []
        out["tags"] = json.dumps(sorted({str(t).strip()[:40] for t in tags if str(t).strip()})[:20], ensure_ascii=False)
    if "description" in body:
        out["description"] = str(body.get("description") or "")[:4000]
    if "definition" in body or not partial:
        try:
            out["definition"] = json.dumps(clean_definition(body.get("definition") or {}))
        except (ValueError, TypeError) as e:
            raise HTTPException(400, str(e) or "Définition invalide")
    return out


@router.get("/api/tactics/categories")
def categories():
    return [{"key": k, "label": l} for k, l in CATEGORIES]


@router.get("/api/tactics")
def list_tactics(map: str | None = None, side: str | None = None, db: Session = Depends(get_session)):
    q = select(Tactic).order_by(Tactic.map_name, Tactic.side, Tactic.category, Tactic.name)
    if map:
        q = q.where(Tactic.map_name == map)
    if side:
        q = q.where(Tactic.side == side.upper())
    return [tactic_dict(t) for t in db.scalars(q)]


@router.post("/api/tactics")
def create(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    t = Tactic(**_clean(body, partial=False), created_by=user.id if user else None)
    db.add(t)
    db.commit()
    _bump()
    return tactic_dict(t)


def _get(db: Session, tid: int) -> Tactic:
    t = db.get(Tactic, tid)
    if t is None:
        raise HTTPException(404, "Tactique introuvable")
    return t


@router.get("/api/tactics/{tid}")
def get(tid: int, db: Session = Depends(get_session)):
    return tactic_dict(_get(db, tid))


@router.patch("/api/tactics/{tid}")
def update(tid: int, body: dict = Body(...), _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    t = _get(db, tid)
    for k, v in _clean(body, partial=True).items():
        setattr(t, k, v)
    db.commit()
    _bump()
    return tactic_dict(t)


@router.delete("/api/tactics/{tid}")
def delete(tid: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    db.delete(_get(db, tid))
    db.commit()
    _bump()
    return {"ok": True}


@router.get("/api/playbook/{team_id}")
def playbook(request: Request, team_id: int, map: str, side: str = "T", lib: LibraryFilters = Depends(lib_filters),
             db: Session = Depends(get_session)):
    """Playbook v2 d'une équipe sur une carte et un camp : rounds avec séquence de tactiques, catégories, tranches, tempo, sites."""
    side = side.upper()
    if side not in ("CT", "T") or map not in request.app.state.maps:
        raise HTTPException(400, "Camp ou carte invalide")
    ids = filtered_match_ids(db, lib, map)
    stamp = db.execute(select(func.count(Tactic.id), func.max(Tactic.updated_at), func.max(Tactic.id))).one()
    key = ("playbook2", team_id, map, side, lib_key(lib), tuple(str(x) for x in stamp), _version[0])
    return _cache.get(db, key, lambda: detect_playbook(db, request.app.state.maps, team_id, map, side, ids))
