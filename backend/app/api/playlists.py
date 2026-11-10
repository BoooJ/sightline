# backend/app/api/playlists.py
import json

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import current_user
from app.storage.models import Demo, Match, Playlist, PlaylistItem, Round, User
from app.storage.repository import _match_summary, _rounds_with_scores

router = APIRouter(prefix="/api/playlists", tags=["playlists"])


def _get(db: Session, pid: int) -> Playlist:
    p = db.get(Playlist, pid)
    if p is None:
        raise HTTPException(404, "Playlist introuvable")
    return p


def _head(p: Playlist, db: Session | None = None, users: dict[int, User] | None = None) -> dict:
    author = None
    if p.created_by:
        u = (users or {}).get(p.created_by) or (db.get(User, p.created_by) if db else None)
        author = u.display_name if u else None
    maps: list[str] = []
    if db is not None and p.items:
        demo_ids = {i.demo_id for i in p.items}
        maps = sorted(set(db.scalars(select(Match.map_name).where(Match.demo_id.in_(demo_ids)))))
    return {"id": p.id, "name": p.name, "description": p.description, "count": len(p.items), "folder": p.folder or "",
            "favorite": bool(p.favorite), "tags": json.loads(p.tags or "[]"), "author": author, "maps": maps,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None}


def _apply(p: Playlist, body: dict) -> None:
    if "name" in body:
        if not str(body["name"]).strip():
            raise HTTPException(400, "Nom requis")
        p.name = str(body["name"]).strip()[:128]
    if "description" in body:
        p.description = str(body["description"])
    if "folder" in body:
        p.folder = str(body["folder"] or "").strip()[:128]
    if "favorite" in body:
        p.favorite = bool(body["favorite"])
    if "tags" in body:
        tags = body["tags"] if isinstance(body["tags"], list) else []
        p.tags = json.dumps(sorted({str(t).strip()[:40] for t in tags if str(t).strip()})[:20], ensure_ascii=False)


def _detail(db: Session, p: Playlist) -> dict:
    by_demo: dict[int, tuple[dict, dict[int, dict]]] = {}
    for demo_id in {i.demo_id for i in p.items}:
        m = db.scalar(select(Match).where(Match.demo_id == demo_id))
        if m is not None:
            by_demo[demo_id] = (_match_summary(m), {r["number"]: r for r in _rounds_with_scores(m)})
    items = []
    for i in sorted(p.items, key=lambda x: x.position):
        match, rounds = by_demo.get(i.demo_id, (None, {}))
        items.append({"id": i.id, "position": i.position, "note": i.note, "demo_id": i.demo_id,
                      "round_number": i.round_number, "match": match, "round": rounds.get(i.round_number)})
    return {**_head(p, db), "items": items}


def _renumber(p: Playlist) -> None:
    for k, i in enumerate(sorted(p.items, key=lambda x: x.position)):
        i.position = k


@router.get("")
def list_playlists(db: Session = Depends(get_session)):
    rows = list(db.scalars(select(Playlist).order_by(Playlist.updated_at.desc(), Playlist.id.desc())))
    ids = {p.created_by for p in rows if p.created_by}
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}
    return [_head(p, db, users) for p in rows]


@router.post("")
def create(body: dict = Body(...), user: User | None = Depends(current_user), db: Session = Depends(get_session)):
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "Nom requis")
    p = Playlist(name=name[:128], description=str(body.get("description", "")), created_by=user.id if user else None)
    _apply(p, {k: v for k, v in body.items() if k in ("folder", "favorite", "tags")})
    db.add(p)
    db.commit()
    return _head(p, db)


@router.get("/{pid}")
def get(pid: int, db: Session = Depends(get_session)):
    return _detail(db, _get(db, pid))


@router.patch("/{pid}")
def update(pid: int, body: dict = Body(...), db: Session = Depends(get_session)):
    p = _get(db, pid)
    _apply(p, body)
    db.commit()
    return _head(p, db)


@router.delete("/{pid}")
def remove(pid: int, db: Session = Depends(get_session)):
    db.delete(_get(db, pid))
    db.commit()
    return {"ok": True}


@router.post("/{pid}/items")
def add_items(pid: int, body: dict = Body(...), db: Session = Depends(get_session)):
    """Ajoute des rounds (ids de round) à la fin ; les doublons sont ignorés."""
    p = _get(db, pid)
    have = {(i.demo_id, i.round_number) for i in p.items}
    pos = len(p.items)
    added = 0
    rounds = [db.get(Round, int(rid)) for rid in body.get("rounds", [])]
    if any(r is None for r in rounds):
        raise HTTPException(404, "Round introuvable")
    for mid in body.get("matches", []):  # matchs entiers : tous leurs rounds, dans l'ordre
        m = db.get(Match, int(mid))
        if m is None:
            raise HTTPException(404, f"Match {mid} introuvable")
        rounds.extend(sorted(m.rounds, key=lambda r: r.number))
    for r in rounds:
        key = (r.match.demo_id, r.number)
        if key in have:
            continue
        have.add(key)
        p.items.append(PlaylistItem(demo_id=key[0], round_number=key[1], position=pos, note=""))
        pos += 1
        added += 1
    p.updated_at = func.now()
    db.commit()
    return {"added": added, **_head(p, db)}


@router.patch("/{pid}/items/{item_id}")
def update_item(pid: int, item_id: int, body: dict = Body(...), db: Session = Depends(get_session)):
    p = _get(db, pid)
    item = next((i for i in p.items if i.id == item_id), None)
    if item is None:
        raise HTTPException(404, "Élément introuvable")
    if "note" in body:
        item.note = str(body["note"])
    if "position" in body:
        ordered = sorted(p.items, key=lambda x: x.position)
        ordered.remove(item)
        ordered.insert(max(0, min(len(ordered), int(body["position"]))), item)
        for k, i in enumerate(ordered):
            i.position = k
    db.commit()
    return _detail(db, p)


@router.delete("/{pid}/items/{item_id}")
def remove_item(pid: int, item_id: int, db: Session = Depends(get_session)):
    p = _get(db, pid)
    item = next((i for i in p.items if i.id == item_id), None)
    if item is None:
        raise HTTPException(404, "Élément introuvable")
    p.items.remove(item)
    _renumber(p)
    db.commit()
    return _detail(db, p)
