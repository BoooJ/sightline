# backend/app/stats/compare.py
"""Référence de comparaison (comme « Comparing To » d'EDGE) : la moyenne, pondérée par les rounds, des joueurs
d'équipes de référence de la bibliothèque sur une fenêtre récente ; ou, en mode « soi-même », la forme passée du
joueur (ses N matchs précédant la sélection courante). Chaque référence porte son effectif : avec peu de démos, un
écart sans effectif tromperait."""
from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.stats.compute import career_stats
from app.storage.labels import LibraryFilters, filtered_match_ids, match_date
from app.storage.models import Match, MatchPlayer

# moyennes pondérées par les rounds de chaque joueur
WEIGHTED = ("rating", "adr", "kpr", "dpr", "kast", "hs_pct")


def _average(rows: list[dict]) -> dict:
    rows = [r for r in rows if r.get("rounds")]
    rounds = sum(r["rounds"] for r in rows)
    if not rounds:
        return {"rounds": 0, "players": 0, "stats": {}}
    stats = {k: sum(r[k] * r["rounds"] for r in rows) / rounds for k in WEIGHTED}
    ok, od = sum(r["opening_kills"] for r in rows), sum(r["opening_deaths"] for r in rows)
    cw, cp = sum(r["clutches_won"] for r in rows), sum(r["clutches_played"] for r in rows)
    stats.update({
        "opening_pct": 100 * ok / (ok + od) if ok + od else 0.0,
        "utility_pr": sum(r["utility_dmg"] for r in rows) / rounds,
        "trade_kills_pr": sum(r["trade_kills"] for r in rows) / rounds,
        "clutch_pct": 100 * cw / cp if cp else 0.0,
        "diff_pr": sum(r["diff"] for r in rows) / rounds,
    })
    return {"rounds": rounds, "players": len(rows), "stats": stats}


def baseline_players(session: Session, team_ids: list[int], months: int | None, side: str | None, map_name: str | None,
                     econ: str | None, opp_econ: str | None, kind: str | None = None) -> dict:
    """Moyenne des joueurs des équipes `team_ids` sur leurs matchs des `months` derniers mois (mêmes filtres de
    camp, carte et économie que la page qui compare)."""
    lib = LibraryFilters(months=months, kind=kind)
    ids = filtered_match_ids(session, lib, map_name)
    own = set(session.scalars(select(MatchPlayer.steamid).where(MatchPlayer.team_id.in_(team_ids)))) if team_ids else set()
    rows = [r for r in career_stats(session, side, map_name, econ, ids, opp_econ) if r["steamid"] in own]
    return {"mode": "teams", "teams": team_ids, "months": months, **_average(rows)}


def baseline_self(session: Session, steamid: str, current_ids: set[int] | None, side: str | None, map_name: str | None,
                  econ: str | None, opp_econ: str | None, n: int | None = None) -> dict:
    """Forme passée du joueur : ses matchs hors de la sélection courante, les plus récents d'abord, autant que la
    sélection en compte (ou `n`). Sélection = toute la bibliothèque → rien à comparer."""
    q = select(Match).join(MatchPlayer, MatchPlayer.match_id == Match.id).where(MatchPlayer.steamid == steamid)
    if map_name:
        q = q.where(Match.map_name == map_name)
    mine = list(session.scalars(q))
    if current_ids is None:
        return {"mode": "self", "rounds": 0, "players": 0, "matches": 0, "stats": {}}
    previous = [m for m in mine if m.id not in current_ids]
    previous.sort(key=lambda m: (match_date(m) or date.min, m.id), reverse=True)
    want = n or len([m for m in mine if m.id in current_ids]) or len(previous)
    keep = {m.id for m in previous[:want]}
    rows = [r for r in career_stats(session, side, map_name, econ, keep, opp_econ) if r["steamid"] == steamid] if keep else []
    return {"mode": "self", "matches": len(keep), **_average(rows)}
