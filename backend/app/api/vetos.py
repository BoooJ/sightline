# backend/app/api/vetos.py
"""Vetos enregistrés : la séquence réelle pick / ban d'un match (saisie par l'équipe), source des statistiques
Pick % / Ban % / Played % et des prédictions du simulateur."""
import json
from datetime import date

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import require_user
from app.storage.models import Match, Team, User, VetoRecord

router = APIRouter(prefix="/api/vetos", tags=["vetos"])
ACTIONS = ("ban", "pick", "decider")
FORMATS = ("bo1", "bo3", "bo5")


def _dict(v: VetoRecord, teams: dict[int, str]) -> dict:
    return {"id": v.id, "team_a": {"id": v.team_a_id, "name": teams.get(v.team_a_id, "?")}, "team_b": {"id": v.team_b_id, "name": teams.get(v.team_b_id, "?")},
            "format": v.format, "steps": json.loads(v.steps or "[]"), "match_id": v.match_id,
            "played_on": v.played_on.isoformat() if v.played_on else None, "note": v.note, "created_at": v.created_at.isoformat() if v.created_at else None}


def _teams(db: Session) -> dict[int, str]:
    return {t.id: t.name for t in db.scalars(select(Team))}


def clean_steps(raw, maps: set[str]) -> list[dict]:
    out = []
    seen: set[str] = set()
    for s in raw if isinstance(raw, list) else []:
        if not isinstance(s, dict) or s.get("team") not in ("a", "b") or s.get("action") not in ACTIONS or s.get("map") not in maps:
            raise ValueError("Étape invalide (team a/b, action ban/pick/decider, carte connue)")
        if s["map"] in seen:
            raise ValueError("Une carte ne peut apparaître qu'une fois")
        seen.add(s["map"])
        out.append({"team": s["team"], "action": s["action"], "map": s["map"]})
    if not out:
        raise ValueError("Aucune étape")
    return out


@router.get("")
def list_vetos(team: int | None = None, db: Session = Depends(get_session)):
    q = select(VetoRecord).order_by(VetoRecord.played_on.desc().nullslast(), VetoRecord.id.desc())
    if team:
        q = q.where((VetoRecord.team_a_id == team) | (VetoRecord.team_b_id == team))
    teams = _teams(db)
    return [_dict(v, teams) for v in db.scalars(q)]


@router.post("")
def create(request: Request, body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    a, b = db.get(Team, int(body.get("team_a", 0))), db.get(Team, int(body.get("team_b", 0)))
    if a is None or b is None or a.id == b.id:
        raise HTTPException(400, "Deux équipes différentes sont requises")
    fmt = str(body.get("format", "bo3"))
    if fmt not in FORMATS:
        raise HTTPException(400, "Format inconnu")
    try:
        steps = clean_steps(body.get("steps"), set(request.app.state.maps.keys()))
    except ValueError as e:
        raise HTTPException(400, str(e))
    played = None
    if body.get("played_on"):
        try:
            played = date.fromisoformat(str(body["played_on"]))
        except ValueError:
            raise HTTPException(400, "Date invalide (AAAA-MM-JJ)")
    mid = int(body["match_id"]) if body.get("match_id") else None
    if mid and db.get(Match, mid) is None:
        raise HTTPException(404, "Match introuvable")
    v = VetoRecord(team_a_id=a.id, team_b_id=b.id, format=fmt, steps=json.dumps(steps), match_id=mid, played_on=played,
                   note=str(body.get("note", ""))[:200], created_by=user.id if user else None)
    db.add(v)
    db.commit()
    return _dict(v, _teams(db))


@router.delete("/{vid}")
def delete(vid: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    v = db.get(VetoRecord, vid)
    if v is None:
        raise HTTPException(404, "Veto introuvable")
    db.delete(v)
    db.commit()
    return {"ok": True}
