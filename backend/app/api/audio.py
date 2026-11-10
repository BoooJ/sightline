# backend/app/api/audio.py
"""Communications vocales synchronisées avec le replay (une ou plusieurs pistes par match)."""
import os
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session, get_settings
from app.api.uploads import take_upload
from app.core.config import Settings
from app.storage.models import Match, MatchAudio

router = APIRouter(tags=["audio"])
MIME = {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac",
        ".wav": "audio/wav", ".webm": "audio/webm", ".flac": "audio/flac"}


def _dict(a: MatchAudio) -> dict:
    return {"id": a.id, "label": a.label, "file_name": a.file_name, "offset_s": a.offset_s, "steamid": a.steamid,
            "url": f"/api/audio/{a.id}/file"}


def _match(db: Session, mid: int) -> Match:
    m = db.get(Match, mid)
    if m is None:
        raise HTTPException(404, "Match introuvable")
    return m


@router.get("/api/matches/{match_id}/audio")
def list_audio(match_id: int, db: Session = Depends(get_session)):
    m = _match(db, match_id)
    q = select(MatchAudio).where(MatchAudio.demo_id == m.demo_id).order_by(MatchAudio.id)
    return [_dict(a) for a in db.scalars(q)]


@router.post("/api/matches/{match_id}/audio")
def attach_audio(match_id: int, body: dict = Body(...), db: Session = Depends(get_session),
                 settings: Settings = Depends(get_settings)):
    m = _match(db, match_id)
    upload_id = str(body.get("upload_id", ""))
    name, part = take_upload(settings, upload_id, "audio")
    d = settings.data_dir / "audio"
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"{m.demo_id}-{upload_id[:16]}{Path(name).suffix.lower()}"
    os.replace(part, dest)
    a = MatchAudio(demo_id=m.demo_id, label=(str(body.get("label") or Path(name).stem))[:64], file_name=name,
                   path=str(dest), offset_s=float(body.get("offset_s", 0)), steamid=(str(body.get("steamid") or "")[:32] or None))
    db.add(a)
    db.commit()
    return _dict(a)


@router.patch("/api/audio/{aid}")
def update_audio(aid: int, body: dict = Body(...), db: Session = Depends(get_session)):
    a = db.get(MatchAudio, aid)
    if a is None:
        raise HTTPException(404, "Piste introuvable")
    if "label" in body and str(body["label"]).strip():
        a.label = str(body["label"]).strip()[:64]
    if "offset_s" in body:
        a.offset_s = round(float(body["offset_s"]), 3)
    if "steamid" in body:
        a.steamid = str(body["steamid"] or "")[:32] or None
    db.commit()
    return _dict(a)


@router.delete("/api/audio/{aid}")
def delete_audio(aid: int, db: Session = Depends(get_session)):
    a = db.get(MatchAudio, aid)
    if a is None:
        raise HTTPException(404, "Piste introuvable")
    Path(a.path).unlink(missing_ok=True)
    db.delete(a)
    db.commit()
    return {"ok": True}


@router.get("/api/audio/{aid}/file")
def audio_file(aid: int, db: Session = Depends(get_session)):
    a = db.get(MatchAudio, aid)
    if a is None or not Path(a.path).exists():
        raise HTTPException(404, "Fichier audio introuvable")
    # FileResponse gère les requêtes Range : le lecteur se positionne n'importe où sans tout télécharger
    return FileResponse(a.path, media_type=MIME.get(Path(a.path).suffix.lower(), "application/octet-stream"),
                        headers={"Cache-Control": "private, max-age=86400"})
