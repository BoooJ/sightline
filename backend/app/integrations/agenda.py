"""Calendrier synchronisé (PRACC → extension → n8n W1 ; FACEIT → n8n W6) et message de prép d'avant-match (n8n W5).

`sync` remplace les événements à venir d'une source par ceux reçus : un prac annulé sur PRACC disparaît, un horaire
déplacé suit (et il est rendu, pour le message Discord de W6). Un match lu sur FACEIT l'emporte sur sa copie PRACC. `claim_upcoming` rend une seule fois chaque match, scrim ou tournoi qui commence bientôt, avec notre
historique contre l'adversaire (de notre point de vue) et ses cartes vues dans nos démos."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.calendar import KINDS, _norm, to_utc, utc_iso
from app.integrations import map_odds
from app.integrations.ours import linked_steamids, our_team_id
from app.maps.registry import MapMeta
from app.storage.labels import match_date
from app.storage.models import CalendarEvent, Match

PREP_KINDS = ("match", "scrim", "tournament")  # pas les entraînements ni le reste
TWIN = timedelta(days=3)  # la copie PRACC d'un match FACEIT peut garder l'ancien horaire : même adversaire, à 3 jours près


def _fields(raw: dict) -> dict | None:
    """Événement envoyé par n8n, vérifié comme une saisie du site ; None s'il est inutilisable."""
    title = str(raw.get("title") or "").strip()[:120]
    kind = raw.get("kind") if raw.get("kind") in KINDS else "other"
    try:
        starts_at = to_utc(str(raw.get("starts_at") or ""))
    except ValueError:
        return None
    if not title:
        return None
    return {"title": title, "kind": kind, "starts_at": starts_at, "opponent": str(raw.get("opponent") or "").strip()[:128],
            "notes": str(raw.get("notes") or "")[:5000]}


def _twin(opponent: str, starts_at: datetime, rows: list[CalendarEvent]) -> bool:
    opp = _norm(opponent)
    return bool(opp) and any(abs(r.starts_at - starts_at) <= TWIN and (opp in _norm(r.opponent) or _norm(r.opponent) in opp)
                             for r in rows if _norm(r.opponent))


def _faceit(db: Session, now: datetime) -> list[CalendarEvent]:
    return list(db.scalars(select(CalendarEvent).where(CalendarEvent.source == "faceit",
                                                       CalendarEvent.starts_at >= now - TWIN)))


def sync(db: Session, source: str, events: list, now: datetime) -> dict:
    """{created, updated, removed, moved} ; `moved` : les événements à venir dont l'horaire vient de changer."""
    official = [] if source == "faceit" else _faceit(db, now)  # matchs déjà lus sur FACEIT : leur copie est écartée
    seen: set[str] = set()
    moved: list[dict] = []
    created = updated = 0
    for raw in events[:200]:
        ext = str(raw.get("external_id") or "").strip()[:128] if isinstance(raw, dict) else ""
        f = _fields(raw) if ext else None
        if f is None or ext in seen or (f["kind"] == "match" and _twin(f["opponent"], f["starts_at"], official)):
            continue
        seen.add(ext)
        row = db.scalar(select(CalendarEvent).where(CalendarEvent.source == source, CalendarEvent.external_id == ext))
        if row is None:
            row = CalendarEvent(source=source, external_id=ext)
            db.add(row)
            created += 1
        else:
            if row.starts_at != f["starts_at"]:
                row.announced_at = None  # horaire déplacé : la prép repartira pour le nouvel horaire
                if f["starts_at"] > now:
                    moved.append({"title": f["title"], "opponent": f["opponent"], "before": utc_iso(row.starts_at),
                                  "after": utc_iso(f["starts_at"])})
            updated += 1
        for k, v in f.items():
            setattr(row, k, v)
    gone = [e for e in db.scalars(select(CalendarEvent).where(CalendarEvent.source == source, CalendarEvent.starts_at >= now))
            if e.external_id not in seen]  # le passé ne bouge plus : un prac joué reste au calendrier
    for e in gone:
        db.delete(e)
    if source == "faceit":  # et dans l'autre sens : la copie PRACC déjà au calendrier part
        db.flush()
        official = _faceit(db, now)
        for e in db.scalars(select(CalendarEvent).where(CalendarEvent.source == "pracc", CalendarEvent.kind == "match",
                                                        CalendarEvent.starts_at >= now)):
            if _twin(e.opponent, e.starts_at, official):
                db.delete(e)
    db.commit()
    return {"created": created, "updated": updated, "removed": len(gone), "moved": moved}


def _prep(db: Session, e: CalendarEvent, matches: list[Match], linked: set[str], maps: dict[str, MapMeta],
          base: str) -> dict:
    opp = _norm(e.opponent)

    def named(name: str) -> bool:
        n = _norm(name)
        return bool(opp) and bool(n) and (opp in n or n in opp)

    def shown(m: Match) -> str:
        return maps[m.map_name].display_name if m.map_name in maps else m.map_name

    history, theirs = [], Counter()
    for m in matches:
        teams = {m.team_a_id: m.team_a, m.team_b_id: m.team_b}
        if not any(named(t.name) for t in teams.values()):
            continue
        theirs[shown(m)] += 1  # leurs cartes, d'après toutes nos démos où ils jouent
        us = our_team_id(db, m, linked)
        if us is None or named(teams[us].name):
            continue
        su, st = (m.score_a, m.score_b) if us == m.team_a_id else (m.score_b, m.score_a)
        played = match_date(m)
        history.append({"match_id": m.id, "date": played.isoformat() if played else None, "map": shown(m),
                        "score": [su, st], "result": "win" if su > st else "loss" if su < st else "draw",
                        "url": f"{base}/matches/{m.id}" if base else None})
    history.sort(key=lambda h: h["date"] or "", reverse=True)
    record = Counter(h["result"] for h in history)
    return {"id": e.id, "title": e.title, "kind": e.kind, "opponent": e.opponent, "starts_at": utc_iso(e.starts_at),
            "notes": e.notes, "url": f"{base}/calendar" if base else None, "likely_maps": map_odds.stored(e),
            "history": {"win": record["win"], "loss": record["loss"], "draw": record["draw"], "matches": history[:5]},
            "their_maps": [{"map": k, "count": n} for k, n in theirs.most_common(5)]}


def claim_upcoming(db: Session, maps: dict[str, MapMeta], hours: int, now: datetime, base: str) -> list[dict]:
    """Matchs, scrims et tournois qui commencent dans les `hours` prochaines heures et pas encore annoncés : rendus une
    seule fois (marqués annoncés), le message de prép ne part jamais deux fois."""
    rows = list(db.scalars(select(CalendarEvent).where(
        CalendarEvent.announced_at.is_(None), CalendarEvent.kind.in_(PREP_KINDS),
        CalendarEvent.starts_at > now, CalendarEvent.starts_at <= now + timedelta(hours=hours)).order_by(CalendarEvent.starts_at)))
    if not rows:
        return []
    matches, linked = list(db.scalars(select(Match))), linked_steamids(db)
    out = [_prep(db, e, matches, linked, maps, base) for e in rows]
    for e in rows:
        e.announced_at = now
    db.commit()
    return out
