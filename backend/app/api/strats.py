# backend/app/api/strats.py
"""Stratbook d'équipe : tactiques par carte et par camp (positions, grenades, dessins, notes), créées depuis le replay
ou la bibliothèque de grenades."""
import json
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.annotations import _clean
from app.api.deps import get_session
from app.auth.core import require_user
from app.storage.models import Match, Strat, User

router = APIRouter(prefix="/api/strats", tags=["strats"])
TYPES = ("execute", "default", "rush", "setup", "retake", "other")
GRENADES = ("smoke", "flash", "he", "molotov", "incendiary", "decoy")
STATUSES = ("ready", "wip")
# code couleur du stratbook de l'équipe : le genre de round que joue la stratégie
CATEGORIES = ("pistol", "eco", "anti_eco", "force", "rapide", "lance", "controle", "finition", "reaction", "indiv")
_SETPOS = re.compile(r"^setpos -?[\d.]+ -?[\d.]+ -?[\d.]+;\s*setang -?[\d.]+ -?[\d.]+ -?[\d.]+$")
_URL = re.compile(r"^https?://[^\s<>\"]+$")


def _num(v, name: str) -> float:
    if not isinstance(v, (int, float)):
        raise HTTPException(400, f"{name} invalide")
    return round(float(v), 2)


def _vec(v, name: str) -> list[float] | None:
    if v is None:
        return None
    if not isinstance(v, list) or len(v) != 3:
        raise HTTPException(400, f"{name} invalide")
    return [_num(x, name) for x in v]


def _clean_body(body: dict, partial: bool) -> dict:
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
    if "type" in body:
        if body["type"] not in TYPES:
            raise HTTPException(400, "Type invalide")
        out["type"] = body["type"]
    if "description" in body:
        out["description"] = str(body.get("description") or "")[:10000]
    if "tags" in body:
        tags = body["tags"] if isinstance(body["tags"], list) else []
        out["tags"] = json.dumps(sorted({str(t).strip()[:40] for t in tags if str(t).strip()})[:20], ensure_ascii=False)
    if "positions" in body:
        pos = body["positions"] or []
        if not isinstance(pos, list) or len(pos) > 5:
            raise HTTPException(400, "5 positions maximum")
        out["positions"] = json.dumps([{"name": str(p.get("name", ""))[:64], "role": str(p.get("role", ""))[:64],
                                        "pos": _vec(p.get("pos"), "position"), "yaw": _num(p.get("yaw", 0), "angle")}
                                       for p in pos], ensure_ascii=False)
    if "grenades" in body:
        gr = body["grenades"] or []
        if not isinstance(gr, list) or len(gr) > 30:
            raise HTTPException(400, "30 grenades maximum")
        clean = []
        for g in gr:
            if g.get("type") not in GRENADES:
                raise HTTPException(400, "Type de grenade invalide")
            sp = g.get("setpos")
            if sp is not None and not _SETPOS.match(str(sp)):
                raise HTTPException(400, "Commande setpos invalide")
            traj = g.get("trajectory") or []
            if not isinstance(traj, list) or len(traj) > 64:
                raise HTTPException(400, "Trajectoire invalide")
            clean.append({"type": g["type"], "player": str(g.get("player", ""))[:64], "note": str(g.get("note", ""))[:200],
                          "throw": _vec(g.get("throw"), "lancer"), "land": _vec(g.get("land"), "impact"), "setpos": sp,
                          "timing_s": _num(g["timing_s"], "timing") if g.get("timing_s") is not None else None,
                          "trajectory": [_vec(p, "trajectoire") for p in traj]})
        out["grenades"] = json.dumps(clean, ensure_ascii=False)
    if "shapes" in body:
        out["shapes"] = json.dumps(_clean({"shapes": body.get("shapes") or []})["shapes"], ensure_ascii=False)
    if "roles" in body:
        roles = body["roles"] or []
        if not isinstance(roles, list) or len(roles) > 10:
            raise HTTPException(400, "10 consignes maximum")
        clean_roles = [{"player": str(r.get("player", "")).strip()[:64], "call": str(r.get("call", "")).strip()[:600]}
                       for r in roles if isinstance(r, dict)]
        out["roles"] = json.dumps([r for r in clean_roles if r["player"] or r["call"]], ensure_ascii=False)
    if "status" in body:
        if body["status"] not in (None, *STATUSES):
            raise HTTPException(400, "Statut invalide (ready, wip)")
        out["status"] = body["status"]
    if "category" in body:
        if body["category"] not in (None, *CATEGORIES):
            raise HTTPException(400, "Catégorie invalide")
        out["category"] = body["category"]
    if "links" in body:
        links = body["links"] or []
        if not isinstance(links, list) or len(links) > 10:
            raise HTTPException(400, "10 liens maximum")
        clean_links = []
        for ln in links:
            url = str((ln or {}).get("url", "")).strip() if isinstance(ln, dict) else ""
            if not _URL.match(url) or len(url) > 500:
                raise HTTPException(400, "Lien invalide (adresse http ou https)")
            clean_links.append({"url": url, "label": str(ln.get("label") or "").strip()[:60]})
        out["links"] = json.dumps(clean_links, ensure_ascii=False)
    if "source" in body:
        src = body.get("source") or None
        if src is not None:
            src = {"match_id": int(src.get("match_id")), "round_number": int(src.get("round_number")),
                   "tick": int(src["tick"]) if src.get("tick") is not None else None}
        out["source"] = json.dumps(src) if src else None
    return out


def _dict(s: Strat, users: dict[int, User] | None = None, full: bool = True) -> dict:
    u = (users or {}).get(s.created_by) if s.created_by else None
    d = {"id": s.id, "name": s.name, "map": s.map_name, "side": s.side, "type": s.type, "tags": json.loads(s.tags or "[]"),
         "status": s.status, "category": s.category,
         "author": u.display_name if u else None, "updated_at": s.updated_at.isoformat() if s.updated_at else None,
         "counts": {"positions": len(json.loads(s.positions or "[]")), "grenades": len(json.loads(s.grenades or "[]")),
                    "shapes": len(json.loads(s.shapes or "[]"))}}
    if full:
        d.update({"description": s.description or "", "positions": json.loads(s.positions or "[]"),
                  "grenades": json.loads(s.grenades or "[]"), "shapes": json.loads(s.shapes or "[]"),
                  "source": json.loads(s.source) if s.source else None,
                  "roles": json.loads(s.roles or "[]"), "links": json.loads(s.links or "[]")})
    return d


def _users(db: Session, rows: list[Strat]) -> dict[int, User]:
    ids = {s.created_by for s in rows if s.created_by}
    return {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}


@router.get("")
def list_strats(map: str | None = None, side: str | None = None, _: User | None = Depends(require_user),
                db: Session = Depends(get_session)):
    q = select(Strat).order_by(Strat.map_name, Strat.side, Strat.name)
    if map:
        q = q.where(Strat.map_name == map)
    if side:
        q = q.where(Strat.side == side.upper())
    rows = list(db.scalars(q))
    users = _users(db, rows)
    return [_dict(s, users, full=False) for s in rows]


@router.post("")
def create(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    data = _clean_body(body, partial=False)
    if "source" in data and data["source"]:
        src = json.loads(data["source"])
        if db.get(Match, src["match_id"]) is None:
            raise HTTPException(400, "Match source introuvable")
    s = Strat(**{"type": "other", "description": "", "tags": "[]", "positions": "[]", "grenades": "[]", "shapes": "[]",
                 "roles": "[]", "links": "[]", **data},
              created_by=user.id if user else None)
    db.add(s)
    db.commit()
    return _dict(s, _users(db, [s]))


def _get(db: Session, sid: int) -> Strat:
    s = db.get(Strat, sid)
    if s is None:
        raise HTTPException(404, "Stratégie introuvable")
    return s


@router.get("/{sid}")
def get(sid: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    s = _get(db, sid)
    return _dict(s, _users(db, [s]))


@router.patch("/{sid}")
def update(sid: int, body: dict = Body(...), _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    s = _get(db, sid)
    for k, v in _clean_body(body, partial=True).items():
        setattr(s, k, v)
    db.commit()
    return _dict(s, _users(db, [s]))


@router.post("/{sid}/grenades")
def add_grenade(sid: int, body: dict = Body(...), _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    """Ajoute une grenade (depuis la bibliothèque de grenades) à une stratégie existante."""
    s = _get(db, sid)
    current = json.loads(s.grenades or "[]")
    s.grenades = _clean_body({"grenades": [*current, body]}, partial=True)["grenades"]
    db.commit()
    return _dict(s, _users(db, [s]))


@router.delete("/{sid}")
def delete(sid: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    db.delete(_get(db, sid))
    db.commit()
    return {"ok": True}
