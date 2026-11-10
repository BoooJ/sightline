# backend/app/api/playbook.py
"""Mémo d'équipe du stratbook : lexique des annonces, rappels de jeu, rôles par carte et notes libres. Commun à toute
l'équipe et modifiable par chacun, comme les stratégies."""
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import require_user
from app.storage.models import PlaybookEntry, User

router = APIRouter(prefix="/api/playbook", tags=["playbook"])
KINDS = ("codeword", "rule", "roles", "note")
_URL = re.compile(r"^https?://[^\s<>\"]+$")


def _clean(body: dict, partial: bool) -> dict:
    out: dict = {}
    if not partial or "kind" in body:
        if body.get("kind") not in KINDS:
            raise HTTPException(400, "Genre invalide (codeword, rule, roles, note)")
        out["kind"] = body["kind"]
    if not partial or "title" in body:
        title = str(body.get("title") or "").strip()
        if not title:
            raise HTTPException(400, "Titre requis")
        out["title"] = title[:120]
    if "body" in body:
        text = str(body.get("body") or "").strip()
        if len(text) > 4000:
            raise HTTPException(400, "Texte trop long (4000 caractères max.)")
        out["body"] = text
    if "map" in body:
        out["map_name"] = str(body.get("map") or "").strip()[:64] or None
    if "side" in body:
        if body.get("side") not in (None, "T", "CT"):
            raise HTTPException(400, "Camp invalide (T, CT ou les deux)")
        out["side"] = body.get("side")
    if "link" in body:
        link = str(body.get("link") or "").strip() or None
        if link and (not _URL.match(link) or len(link) > 500):
            raise HTTPException(400, "Lien invalide (adresse http ou https)")
        out["link"] = link
    if "position" in body:
        try:
            pos = int(body.get("position") or 0)
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(400, "Position invalide")
        if not -1_000_000 <= pos <= 1_000_000:
            raise HTTPException(400, "Position invalide")
        out["position"] = pos
    return out


def _dict(e: PlaybookEntry) -> dict:
    return {"id": e.id, "kind": e.kind, "title": e.title, "body": e.body or "", "map": e.map_name, "side": e.side,
            "link": e.link, "position": e.position, "updated_at": e.updated_at.isoformat() if e.updated_at else None}


@router.get("")
def list_entries(_: User | None = Depends(require_user), db: Session = Depends(get_session)):
    rows = db.scalars(select(PlaybookEntry).order_by(PlaybookEntry.kind, PlaybookEntry.position, PlaybookEntry.id))
    return [_dict(e) for e in rows]


@router.post("")
def create(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    e = PlaybookEntry(**{"body": "", "position": 0, **_clean(body, partial=False)}, created_by=user.id if user else None)
    db.add(e)
    db.commit()
    return _dict(e)


def _get(db: Session, eid: int) -> PlaybookEntry:
    e = db.get(PlaybookEntry, eid)
    if e is None:
        raise HTTPException(404, "Entrée introuvable")
    return e


@router.patch("/{eid}")
def update(eid: int, body: dict = Body(...), _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    e = _get(db, eid)
    for k, v in _clean(body, partial=True).items():
        setattr(e, k, v)
    db.commit()
    return _dict(e)


@router.delete("/{eid}")
def delete(eid: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    db.delete(_get(db, eid))
    db.commit()
    return {"ok": True}
