# backend/app/api/notes.py
"""Notes des joueurs, écrites depuis l'app ou le site : une carte, et en option un camp, un match, un adversaire ou
une stratégie. Privées par défaut (comme les signets), partagées avec l'équipe sur demande (comme les commentaires)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import require_user
from app.storage.labels import match_date
from app.storage.models import Match, Note, Strat, Team, User

router = APIRouter(prefix="/api/notes", tags=["notes"])

MAX_BODY = 2000
LINKS = {"match_id": (Match, "Match inconnu"), "team_id": (Team, "Équipe inconnue"), "strat_id": (Strat, "Stratégie inconnue")}


def _me(me: User | None) -> int | None:
    # en mode ouvert (sans comptes), « mes » notes sont celles sans auteur
    return me.id if me else None


def _visible(me: User | None):
    mine = Note.user_id == me.id if me else Note.user_id.is_(None)
    return select(Note).where(or_(mine, Note.shared.is_(True)))


def _now() -> datetime:
    # à la microseconde : « la dernière modifiée d'abord » doit rester vrai pour deux écritures dans la même seconde
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean(request: Request, db: Session, body: dict, partial: bool) -> dict:
    out: dict = {}
    if not partial or "map" in body:
        name = str(body.get("map") or "")
        if name not in request.app.state.maps:
            raise HTTPException(400, "Carte inconnue")
        out["map_name"] = name
    if not partial or "body" in body:
        text = str(body.get("body") or "").strip()
        if not text or len(text) > MAX_BODY:
            raise HTTPException(400, f"Note vide ou trop longue ({MAX_BODY} caractères max.)")
        out["body"] = text
    if "side" in body:
        side = body.get("side") or None
        if side not in (None, "T", "CT"):
            raise HTTPException(400, "Camp invalide (T, CT ou les deux)")
        out["side"] = side
    if "shared" in body:
        out["shared"] = bool(body.get("shared"))
    for key, (model, msg) in LINKS.items():
        if key in body:
            raw = body.get(key)
            if raw is None:
                out[key] = None
                continue
            try:
                ref = int(raw)
            except (TypeError, ValueError):
                raise HTTPException(400, msg)
            if db.get(model, ref) is None:
                raise HTTPException(400, msg)
            out[key] = ref
    return out


def _dicts(db: Session, notes: list[Note], me: User | None) -> list[dict]:
    def by_id(model, ids):
        ids = {i for i in ids if i is not None}
        return {o.id: o for o in db.scalars(select(model).where(model.id.in_(ids)))} if ids else {}

    users = by_id(User, (n.user_id for n in notes))
    matches = by_id(Match, (n.match_id for n in notes))
    teams = by_id(Team, (n.team_id for n in notes))
    strats = by_id(Strat, (n.strat_id for n in notes))
    me_id = _me(me)

    def one(n: Note) -> dict:
        u, m, t, s = users.get(n.user_id), matches.get(n.match_id), teams.get(n.team_id), strats.get(n.strat_id)
        d = match_date(m) if m else None
        return {
            "id": n.id, "map": n.map_name, "side": n.side, "body": n.body, "shared": bool(n.shared),
            "mine": n.user_id == me_id, "author": u.display_name if u else "Local", "author_id": n.user_id,
            "match": {"id": m.id, "title": f"{m.team_a.name} vs {m.team_b.name}", "date": d.isoformat() if d else None} if m else None,
            "team": {"id": t.id, "name": t.name} if t else None,
            "strat": {"id": s.id, "name": s.name} if s else None,
            "created_at": n.created_at.isoformat() if n.created_at else None,
            "updated_at": n.updated_at.isoformat() if n.updated_at else None,
        }
    return [one(n) for n in notes]


def _get(db: Session, me: User | None, note_id: int) -> Note:
    n = db.scalar(_visible(me).where(Note.id == note_id))
    if n is None:
        raise HTTPException(404, "Note introuvable")
    return n


@router.get("")
def list_notes(map: str | None = None, side: str | None = None, match: int | None = None, team: int | None = None,
               strat: int | None = None, me: User | None = Depends(require_user), db: Session = Depends(get_session)):
    q = _visible(me)
    if map:
        q = q.where(Note.map_name == map)
    if side in ("T", "CT"):
        q = q.where(or_(Note.side == side, Note.side.is_(None)))  # une note « les deux camps » vaut pour chacun
    if match is not None:
        q = q.where(Note.match_id == match)
    if team is not None:
        q = q.where(Note.team_id == team)
    if strat is not None:
        q = q.where(Note.strat_id == strat)
    rows = list(db.scalars(q.order_by(Note.updated_at.desc(), Note.id.desc()).limit(500)))
    return _dicts(db, rows, me)


@router.get("/{note_id}")
def get_note(note_id: int, me: User | None = Depends(require_user), db: Session = Depends(get_session)):
    return _dicts(db, [_get(db, me, note_id)], me)[0]


@router.post("")
def create_note(request: Request, body: dict = Body(...), me: User | None = Depends(require_user),
                db: Session = Depends(get_session)):
    fields = _clean(request, db, body, partial=False)
    now = _now()
    n = Note(**{"shared": False, "side": None, **fields}, user_id=_me(me), created_at=now, updated_at=now)
    db.add(n)
    db.commit()
    return _dicts(db, [n], me)[0]


@router.patch("/{note_id}")
def update_note(request: Request, note_id: int, body: dict = Body(...), me: User | None = Depends(require_user),
                db: Session = Depends(get_session)):
    n = _get(db, me, note_id)
    if n.user_id != _me(me):
        raise HTTPException(403, "Seul l'auteur peut modifier cette note")
    for k, v in _clean(request, db, body, partial=True).items():
        setattr(n, k, v)
    n.updated_at = _now()
    db.commit()
    return _dicts(db, [n], me)[0]


@router.delete("/{note_id}")
def delete_note(note_id: int, me: User | None = Depends(require_user), db: Session = Depends(get_session)):
    n = _get(db, me, note_id)
    admin = me is not None and me.role in ("owner", "admin")
    if n.user_id != _me(me) and not (n.shared and admin):
        raise HTTPException(403, "Seul l'auteur ou un administrateur peut supprimer cette note")
    db.delete(n)
    db.commit()
    return {"ok": True}
