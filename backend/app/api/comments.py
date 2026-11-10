# backend/app/api/comments.py
import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.annotations import _clean
from app.api.deps import get_session
from app.auth.core import require_user
from app.storage.models import Comment, Match, User

router = APIRouter(tags=["comments"])


def _dict(c: Comment, users: dict[int, User]) -> dict:
    u = users.get(c.user_id) if c.user_id else None
    return {"id": c.id, "round_number": c.round_number, "tick": c.tick, "body": c.body,
            "author": u.display_name if u else "Local", "author_id": c.user_id, "private": bool(c.private),
            "shapes": json.loads(c.shapes) if c.shapes else [],
            "created_at": c.created_at.isoformat() if c.created_at else None}


@router.get("/api/matches/{match_id}/comments")
def list_comments(match_id: int, me: User | None = Depends(require_user), db: Session = Depends(get_session)):
    m = db.get(Match, match_id)
    if m is None:
        raise HTTPException(404, "Match introuvable")
    rows = list(db.scalars(select(Comment).where(Comment.demo_id == m.demo_id)
                           .order_by(Comment.round_number.is_(None).desc(), Comment.round_number, Comment.tick, Comment.id)))
    # commentaires personnels : seulement ceux de l'utilisateur courant (en mode ouvert, ceux sans auteur)
    rows = [c for c in rows if not c.private or c.user_id == (me.id if me else None)]
    ids = {c.user_id for c in rows if c.user_id}
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}
    return [_dict(c, users) for c in rows]


@router.post("/api/matches/{match_id}/comments")
def add_comment(request: Request, match_id: int, body: dict = Body(...), user: User | None = Depends(require_user),
                db: Session = Depends(get_session)):
    m = db.get(Match, match_id)
    if m is None:
        raise HTTPException(404, "Match introuvable")
    text = str(body.get("body", "")).strip()
    if not text or len(text) > 2000:
        raise HTTPException(400, "Commentaire vide ou trop long (2000 caractères max.)")
    rn, tick = body.get("round_number"), body.get("tick")
    if rn is not None and not any(r.number == rn for r in m.rounds):
        raise HTTPException(400, "Round inconnu")
    shapes = _clean({"shapes": body.get("shapes") or []})["shapes"] if body.get("shapes") else []
    c = Comment(demo_id=m.demo_id, round_number=rn, tick=int(tick) if isinstance(tick, (int, float)) else None,
                user_id=user.id if user else None, body=text, private=bool(body.get("private")),
                shapes=json.dumps(shapes, ensure_ascii=False) if shapes else None)
    db.add(c)
    db.commit()
    if not c.private:
        from app.core.notify import notify
        who = user.display_name if user else "Quelqu'un"
        where = f"{m.team_a.name} vs {m.team_b.name}" + (f" · round {rn}" if rn else "")
        notify(db, "comment", f"{who} a commenté {where}", text[:160], f"/matches/{m.id}/replay/{rn}" if rn else f"/matches/{m.id}?tab=comments",
               bus=request.app.state.bus, settings=request.app.state.settings)
    return _dict(c, {user.id: user} if user else {})


@router.delete("/api/comments/{cid}")
def delete_comment(cid: int, user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    c = db.get(Comment, cid)
    if c is None:
        raise HTTPException(404, "Commentaire introuvable")
    if user is not None and c.user_id != user.id and user.role not in ("owner", "admin"):
        raise HTTPException(403, "Seul l'auteur ou un administrateur peut supprimer ce commentaire")
    db.delete(c)
    db.commit()
    return {"ok": True}
