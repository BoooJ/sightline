# backend/app/api/bookmarks.py
"""Signets personnels (Bookmarks d'EDGE) : instants de rounds gardés de côté, avec un libellé."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import require_user
from app.storage.models import Bookmark, Match, User
from app.storage.repository import _match_summary

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])


def _mine(db: Session, me: User | None):
    # signets de l'utilisateur connecté ; en mode ouvert (sans comptes), ceux sans auteur
    return select(Bookmark).where(Bookmark.user_id == me.id) if me else select(Bookmark).where(Bookmark.user_id.is_(None))


def _dict(b: Bookmark, m: Match | None) -> dict:
    return {"id": b.id, "round_number": b.round_number, "tick": b.tick, "label": b.label,
            "created_at": b.created_at.isoformat() if b.created_at else None,
            "match": _match_summary(m) if m else None}


@router.get("")
def list_bookmarks(match: int | None = None, me: User | None = Depends(require_user), db: Session = Depends(get_session)):
    q = _mine(db, me)
    if match is not None:
        m = db.get(Match, match)
        if m is None:
            raise HTTPException(404, "Match introuvable")
        q = q.where(Bookmark.demo_id == m.demo_id)
    rows = list(db.scalars(q.order_by(Bookmark.id.desc())))
    by_demo = {m.demo_id: m for m in db.scalars(select(Match).where(Match.demo_id.in_({b.demo_id for b in rows})))}
    return [_dict(b, by_demo.get(b.demo_id)) for b in rows if b.demo_id in by_demo]


@router.post("")
def add_bookmark(body: dict = Body(...), me: User | None = Depends(require_user), db: Session = Depends(get_session)):
    m = db.get(Match, int(body.get("match_id") or 0))
    if m is None:
        raise HTTPException(404, "Match introuvable")
    try:
        rn, tick = int(body["round_number"]), int(body["tick"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "Round et instant requis")
    b = Bookmark(user_id=me.id if me else None, demo_id=m.demo_id, round_number=rn, tick=tick,
                 label=str(body.get("label") or "").strip()[:120])
    db.add(b)
    db.commit()
    return _dict(b, m)


@router.patch("/{bookmark_id}")
def rename(bookmark_id: int, body: dict = Body(...), me: User | None = Depends(require_user), db: Session = Depends(get_session)):
    b = db.scalar(_mine(db, me).where(Bookmark.id == bookmark_id))
    if b is None:
        raise HTTPException(404, "Signet introuvable")
    b.label = str(body.get("label") or "").strip()[:120]
    db.commit()
    return _dict(b, db.scalar(select(Match).where(Match.demo_id == b.demo_id)))


@router.delete("/{bookmark_id}")
def delete(bookmark_id: int, me: User | None = Depends(require_user), db: Session = Depends(get_session)):
    b = db.scalar(_mine(db, me).where(Bookmark.id == bookmark_id))
    if b is None:
        raise HTTPException(404, "Signet introuvable")
    db.delete(b)
    db.commit()
    return {"ok": True}
