"""Cartes probables d'un match FACEIT du calendrier, calculées par la synchro W6 et montrées partout (site, app, prép).

En BO1, la carte jouée est celle qu'aucune des deux équipes n'a bannie : une carte où les deux finissent souvent. Chaque
carte du pool reçoit donc sa fréquence chez l'adversaire × sa fréquence chez nous (matchs ESEA, lissées pour les petits
échantillons). FACEIT ne donne pas l'ordre des bans, seulement la carte jouée : c'est une tendance, pas une prédiction."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.faceit import scout
from app.faceit.client import FaceitClient, FaceitError
from app.maps.registry import MapMeta
from app.storage.models import CalendarEvent

log = logging.getLogger(__name__)
SMOOTH = 1.0  # une carte jamais vue garde une petite chance
FEW = 5  # moins de matchs ESEA de l'adversaire : estimation fragile, dite comme telle
STALE = timedelta(hours=6)  # recalcul : l'adversaire a pu jouer depuis
AHEAD = timedelta(days=14)


def _pool(overview: dict) -> dict[str, dict]:
    return {e["map"]: e for e in overview.get("map_pool", [])}


def estimate(them: dict, us: dict, active: list[str], names: dict[str, str]) -> dict | None:
    """{maps: [{map, name, pct, played, won}], them, us, few} à partir de deux fiches `scout.team_overview` ; None sans
    match connu de l'adversaire. `played`/`won` : son bilan sur la carte."""
    tp, up = _pool(them), _pool(us)
    played = lambda pool, m: pool.get(m, {}).get("played", 0)  # noqa: E731
    if not active or not sum(played(tp, m) for m in active):
        return None
    k = len(active)
    tt, ut = sum(played(tp, m) for m in active), sum(played(up, m) for m in active)
    w = {m: (played(tp, m) + SMOOTH) / (tt + SMOOTH * k) * (played(up, m) + SMOOTH) / (ut + SMOOTH * k) for m in active}
    total = sum(w.values())
    maps = [{"map": m, "name": names.get(m, m), "pct": round(100 * w[m] / total), "played": played(tp, m),
             "won": tp.get(m, {}).get("won", 0)} for m in sorted(active, key=lambda m: (-w[m], m))]
    n = them.get("record", {}).get("played", 0)
    return {"maps": maps, "them": n, "us": us.get("record", {}).get("played", 0), "few": n < FEW}


def refresh(db: Session, c: FaceitClient, found: dict, maps: dict[str, MapMeta], now: datetime) -> None:
    """Cartes probables des matchs FACEIT des 14 prochains jours, recalculées toutes les 6 h au plus. Une erreur de FACEIT
    garde l'estimation précédente : la synchro du calendrier, elle, est déjà enregistrée."""
    active = sorted(m.name for m in maps.values() if m.active_duty)
    names = {m.name: m.display_name for m in maps.values()}
    lookup = {m.display_name: m.name for m in maps.values()}
    ours = None
    for ev in found.get("events") or []:
        row = db.scalar(select(CalendarEvent).where(CalendarEvent.source == "faceit",
                                                    CalendarEvent.external_id == ev["external_id"]))
        if row is None or not ev.get("opponent_id") or not now <= row.starts_at <= now + AHEAD \
                or (row.map_odds_at and now - row.map_odds_at < STALE):
            continue
        try:
            ours = ours or scout.team_overview(c, found["team_id"], "esea", map_names=lookup, active_maps=active)
            theirs = scout.team_overview(c, ev["opponent_id"], "esea", map_names=lookup, active_maps=active)
        except FaceitError as e:
            log.warning("cartes probables contre %s : %s", row.opponent, e)
            continue  # nouvel essai au passage suivant de W6
        odds = estimate(theirs, ours, active, names)
        row.map_odds, row.map_odds_at = (json.dumps(odds) if odds else None), now
    db.commit()


def stored(e: CalendarEvent) -> dict | None:
    return json.loads(e.map_odds) if e.map_odds else None
