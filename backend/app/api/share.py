# backend/app/api/share.py
"""Liens de partage publics du replay (comme le « Share link » d'EDGE, valable 30 jours) : lecture seule, sans
session, limitée au match partagé."""
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import msgpack
from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.audio import MIME, _dict as audio_dict
from app.api.deps import get_session
from app.auth.core import require_user
from app.storage.models import Match, MatchAudio, Round, ShareLink, User
from app.storage.repository import get_match_detail, get_round_replay

router = APIRouter(tags=["share"])
SHARE_DAYS = 30


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _link(link: ShareLink) -> dict:
    return {"token": link.token, "url": f"/s/{link.token}", "match_id": link.match_id, "round_number": link.round_number,
            "tick": link.tick, "layers": json.loads(link.layers or "[]"), "expires_at": link.expires_at.isoformat()}


def _valid(db: Session, token: str) -> ShareLink:
    link = db.scalar(select(ShareLink).where(ShareLink.token == token))
    if link is None or link.expires_at < _now():
        raise HTTPException(404, "Lien de partage inconnu ou expiré")
    return link


@router.post("/api/share")
def create(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    m = db.get(Match, int(body.get("match_id", 0)))
    if m is None:
        raise HTTPException(404, "Match introuvable")
    number = int(body.get("round_number", 1))
    if not any(r.number == number for r in m.rounds):
        raise HTTPException(400, "Round inconnu pour ce match")
    own = {r.id for r in m.rounds}
    layers = [int(x) for x in body.get("layers", []) if int(x) in own]
    link = ShareLink(token=secrets.token_urlsafe(24), match_id=m.id, round_number=number, tick=max(0, int(body.get("tick", 0))),
                     layers=json.dumps(layers), created_by=user.id if user else None,
                     expires_at=_now() + timedelta(days=SHARE_DAYS))
    db.add(link)
    db.commit()
    return _link(link)


@router.get("/api/share/{token}")
def shared(token: str, request: Request, db: Session = Depends(get_session)):
    link = _valid(db, token)
    detail = get_match_detail(db, link.match_id)
    meta = request.app.state.maps.get(detail["map_name"]) if detail else None
    if detail is None or meta is None:
        raise HTTPException(404, "Match introuvable")
    return {**_link(link), "match": detail, "map": meta.to_dict()}


@router.get("/api/share/{token}/replay/{round_id}")
def shared_replay(token: str, round_id: int, db: Session = Depends(get_session)):
    link = _valid(db, token)
    r = db.get(Round, round_id)
    if r is None or r.match_id != link.match_id:
        raise HTTPException(404, "Round introuvable")
    d = get_round_replay(db, round_id)
    return Response(msgpack.packb(d, use_bin_type=True), media_type="application/msgpack", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/share/{token}/audio")
def shared_audio(token: str, db: Session = Depends(get_session)):
    link = _valid(db, token)
    m = db.get(Match, link.match_id)
    q = select(MatchAudio).where(MatchAudio.demo_id == m.demo_id).order_by(MatchAudio.id)
    return [{**audio_dict(a), "url": f"/api/share/{token}/audio/{a.id}/file"} for a in db.scalars(q)]


@router.get("/api/share/{token}/audio/{aid}/file")
def shared_audio_file(token: str, aid: int, db: Session = Depends(get_session)):
    link = _valid(db, token)
    m = db.get(Match, link.match_id)
    a = db.get(MatchAudio, aid)
    if a is None or a.demo_id != m.demo_id or not Path(a.path).exists():
        raise HTTPException(404, "Fichier audio introuvable")
    return FileResponse(a.path, media_type=MIME.get(Path(a.path).suffix.lower(), "application/octet-stream"),
                        headers={"Cache-Control": "private, max-age=86400"})
