# backend/app/api/scout_players.py
"""Scouting Tool joueurs (comme EDGE) : recherche de joueurs de la bibliothèque (rôle recherché par carte, HLTV, HLTV
relatif, matchs minimum) et shortlists."""
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.api.players import _career, _edge, positions_for
from app.auth.core import require_user
from app.stats.positions import EDGE_ROLE_LABELS
from app.storage.models import Shortlist, ShortlistItem, User

router = APIRouter(tags=["scout-players"])


@router.get("/api/scouting/players")
def search_players(request: Request, map: str | None = None, role_t: str | None = None, role_ct: str | None = None,
                   min_rating: float | None = None, min_matches: int = 1, q: str | None = None, db: Session = Depends(get_session)):
    """Joueurs de la bibliothèque, toutes équipes : sur une carte (rôle T / CT recherché) ou toutes cartes.
    `relative` : rating moins la moyenne des joueurs listés (HLTV relatif, comme EDGE)."""
    if map and map not in request.app.state.maps:
        raise HTTPException(400, "Carte inconnue")
    for r in (role_t, role_ct):
        if r and r not in EDGE_ROLE_LABELS:
            raise HTTPException(400, "Rôle inconnu")
    pos = positions_for(request, db, map, None)
    rows = []
    for p in _career(db, None, map, None):
        if p["matches"] < max(1, min_matches):
            continue
        edge = _edge(pos.get(p["steamid"]))
        if role_t and edge["t"]["role"] != role_t:
            continue
        if role_ct and edge["ct"]["role"] != role_ct:
            continue
        if q and q.lower() not in p["name"].lower() and q.lower() not in p["team"].lower():
            continue
        rows.append({"steamid": p["steamid"], "name": p["name"], "team": p["team"], "matches": p["matches"], "rounds": p["rounds"],
                     "rating": p["rating"], "adr": p["adr"], "kast": p["kast"], "kpr": p["kpr"], "opening_pct": p["opening_pct"],
                     "hs_pct": p["hs_pct"], "edge_roles": edge})
    mean = sum(r["rating"] for r in rows) / len(rows) if rows else 0.0
    for r in rows:
        r["relative"] = round(r["rating"] - mean, 2)
    if min_rating is not None:
        rows = [r for r in rows if r["rating"] >= min_rating]
    rows.sort(key=lambda r: (-r["rating"], r["name"]))
    return {"map": map, "mean_rating": round(mean, 2), "players": rows}


def _list(s: Shortlist) -> dict:
    return {"id": s.id, "name": s.name, "count": len(s.items), "created_at": s.created_at.isoformat() if s.created_at else None,
            "items": [{"id": i.id, "steamid": i.steamid, "name": i.name, "note": i.note, "added_at": i.added_at.isoformat() if i.added_at else None}
                      for i in sorted(s.items, key=lambda x: x.id)]}


@router.get("/api/shortlists")
def shortlists(db: Session = Depends(get_session)):
    return [_list(s) for s in db.scalars(select(Shortlist).order_by(Shortlist.id))]


@router.post("/api/shortlists")
def create_shortlist(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "Nom requis")
    s = Shortlist(name=name[:120], created_by=user.id if user else None)
    db.add(s)
    db.commit()
    return _list(s)


def _get(db: Session, sid: int) -> Shortlist:
    s = db.get(Shortlist, sid)
    if s is None:
        raise HTTPException(404, "Shortlist introuvable")
    return s


@router.delete("/api/shortlists/{sid}")
def delete_shortlist(sid: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    db.delete(_get(db, sid))
    db.commit()
    return {"ok": True}


@router.post("/api/shortlists/{sid}/items")
def add_item(sid: int, body: dict = Body(...), _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    s = _get(db, sid)
    steamid = str(body.get("steamid", "")).strip()
    if not steamid:
        raise HTTPException(400, "Joueur requis")
    existing = next((i for i in s.items if i.steamid == steamid), None)
    if existing is None:
        s.items.append(ShortlistItem(steamid=steamid, name=str(body.get("name", ""))[:128], note=str(body.get("note", ""))[:300]))
    elif "note" in body:
        existing.note = str(body["note"])[:300]
    db.commit()
    return _list(s)


@router.delete("/api/shortlists/{sid}/items/{iid}")
def remove_item(sid: int, iid: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    s = _get(db, sid)
    item = next((i for i in s.items if i.id == iid), None)
    if item is None:
        raise HTTPException(404, "Joueur absent de la shortlist")
    s.items.remove(item)
    db.commit()
    return _list(s)
