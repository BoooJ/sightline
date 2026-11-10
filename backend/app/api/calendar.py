# backend/app/api/calendar.py
"""Calendrier de l'équipe : événements (match, scrim, tournoi, entraînement) avec démos rattachées automatiquement
(même jour à un jour près, adversaire reconnu dans le nom d'une équipe) ou à la main.

Heures : stockées en UTC, renvoyées avec « Z » ; le site et l'app les affichent dans l'heure locale de chacun (l'équipe
est répartie sur plusieurs fuseaux). Une heure reçue sans fuseau est l'heure de l'équipe (Paris)."""
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.auth.core import require_user
from app.integrations import map_odds
from app.storage.labels import match_date
from app.storage.models import CalendarEvent, Match, User
from app.storage.repository import _match_summary

router = APIRouter(prefix="/api/calendar", tags=["calendar"])
KINDS = ("match", "scrim", "tournament", "practice", "other")
TEAM_TZ = ZoneInfo("Europe/Paris")


def to_utc(value: str) -> datetime:
    """Heure ISO (avec ou sans fuseau, « Z » compris) → UTC sans fuseau, comme en base."""
    d = datetime.fromisoformat(value)
    if d.tzinfo is None:
        d = d.replace(tzinfo=TEAM_TZ)
    return d.astimezone(timezone.utc).replace(tzinfo=None)


def utc_iso(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def team_day(d: datetime):
    """Jour de l'événement à Paris (rattachement des démos)."""
    return d.replace(tzinfo=timezone.utc).astimezone(TEAM_TZ).date()


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def _linked(e: CalendarEvent, matches: list[Match]) -> list[Match]:
    manual = set(json.loads(e.match_ids or "[]"))
    opp = _norm(e.opponent)
    day = team_day(e.starts_at)
    out = []
    for m in matches:
        played = match_date(m)  # à un jour près : un soir chez l'un est déjà le lendemain chez l'autre
        auto = bool(opp) and played is not None and abs((played - day).days) <= 1 and any(opp in _norm(t.name) or _norm(t.name) in opp
                                                         for t in (m.team_a, m.team_b) if _norm(t.name))
        if m.id in manual or auto:
            out.append(m)
    return out


def _out(e: CalendarEvent, matches: list[Match]) -> dict:
    manual = set(json.loads(e.match_ids or "[]"))
    return {"id": e.id, "title": e.title, "kind": e.kind, "opponent": e.opponent, "maps": json.loads(e.maps or "[]"),
            "starts_at": utc_iso(e.starts_at), "notes": e.notes, "source": e.source, "likely_maps": map_odds.stored(e),
            "matches": [{**_match_summary(m), "manual": m.id in manual} for m in _linked(e, matches)]}


def _apply(e: CalendarEvent, body: dict, partial: bool) -> None:
    if "title" in body or not partial:
        title = str(body.get("title", "")).strip()[:120]
        if not title:
            raise HTTPException(400, "Titre requis")
        e.title = title
    if "kind" in body or not partial:
        kind = body.get("kind", "match")
        if kind not in KINDS:
            raise HTTPException(400, "Type invalide")
        e.kind = kind
    if "starts_at" in body or not partial:
        try:
            e.starts_at = to_utc(str(body.get("starts_at", "")))
        except ValueError:
            raise HTTPException(400, "Date invalide")
    if "opponent" in body:
        e.opponent = str(body["opponent"] or "").strip()[:128]
    if "notes" in body:
        e.notes = str(body["notes"] or "")[:5000]
    if "maps" in body:
        e.maps = json.dumps([str(m)[:64] for m in (body["maps"] or [])][:7])
    if "match_ids" in body:
        e.match_ids = json.dumps(sorted({int(x) for x in (body["match_ids"] or []) if str(x).isdigit()}))


@router.get("")
def events(start: str | None = None, end: str | None = None, _: User | None = Depends(require_user),
           db: Session = Depends(get_session)):
    """Événements entre start et end (AAAA-MM-JJ, end exclu ; par défaut : les 60 prochains jours)."""
    try:
        a = to_utc(start) if start else datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
        b = to_utc(end) if end else a + timedelta(days=60)
    except ValueError:
        raise HTTPException(400, "Date invalide (AAAA-MM-JJ)")
    rows = list(db.scalars(select(CalendarEvent).where(CalendarEvent.starts_at >= a, CalendarEvent.starts_at < b)
                           .order_by(CalendarEvent.starts_at)))
    matches = list(db.scalars(select(Match)))
    return [_out(e, matches) for e in rows]


@router.post("")
def create(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    e = CalendarEvent(created_by=user.id if user else None)
    _apply(e, body, partial=False)
    db.add(e)
    db.commit()
    return _out(e, list(db.scalars(select(Match))))


@router.patch("/{event_id}")
def update(event_id: int, body: dict = Body(...), _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    e = db.get(CalendarEvent, event_id)
    if e is None:
        raise HTTPException(404, "Événement introuvable")
    _apply(e, body, partial=True)
    db.commit()
    return _out(e, list(db.scalars(select(Match))))


@router.delete("/{event_id}")
def delete(event_id: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    e = db.get(CalendarEvent, event_id)
    if e is None:
        raise HTTPException(404, "Événement introuvable")
    db.delete(e)
    db.commit()
    return {"ok": True}
