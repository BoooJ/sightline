# backend/app/stats/veto.py
"""Données du simulateur de veto (sous-projet « veto ») : force de deux équipes sur chaque carte.

Force = taux de victoire lissé (a priori 50 % pesant PRIOR matchs, pour ne pas surréagir à 1 match) combiné à
l'écart de rounds moyen. La séquence de veto elle-même est jouée côté interface."""
from __future__ import annotations

import math
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.models import Match, Team, VetoRecord

PRIOR = 2.0


def _veto_rates(session: Session, team_id: int, maps: list[str]) -> dict:
    """Pick % / Ban % / Played % d'une équipe sur ses vetos enregistrés (toutes confrontations confondues)."""
    import json
    recs = list(session.scalars(select(VetoRecord).where((VetoRecord.team_a_id == team_id) | (VetoRecord.team_b_id == team_id))))
    pick: dict[str, int] = defaultdict(int)
    ban: dict[str, int] = defaultdict(int)
    played: dict[str, int] = defaultdict(int)
    for r in recs:
        side = "a" if r.team_a_id == team_id else "b"
        for s in json.loads(r.steps or "[]"):
            if s["action"] == "pick" and s["team"] == side:
                pick[s["map"]] += 1
            elif s["action"] == "ban" and s["team"] == side:
                ban[s["map"]] += 1
            if s["action"] in ("pick", "decider"):
                played[s["map"]] += 1
    n = len(recs)
    return {"vetos": n, "maps": {m: {"pick": pick[m], "ban": ban[m], "played": played[m],
                                      "pick_pct": round(100 * pick[m] / n) if n else None, "ban_pct": round(100 * ban[m] / n) if n else None,
                                      "played_pct": round(100 * played[m] / n) if n else None} for m in maps}}


def _team_maps(session: Session, team_id: int) -> dict[str, dict]:
    out: dict[str, dict] = defaultdict(lambda: {"played": 0, "won": 0, "rounds_won": 0, "rounds_lost": 0})
    for m in session.scalars(select(Match).where((Match.team_a_id == team_id) | (Match.team_b_id == team_id))):
        mine, theirs = (m.score_a, m.score_b) if m.team_a_id == team_id else (m.score_b, m.score_a)
        d = out[m.map_name]
        d["played"] += 1
        d["won"] += mine > theirs
        d["rounds_won"] += mine
        d["rounds_lost"] += theirs
    for d in out.values():
        n = d["played"]
        d["win_pct"] = round(100 * d["won"] / n, 1) if n else 0.0
        smoothed = (d["won"] + 0.5 * PRIOR) / (n + PRIOR)
        rd = (d["rounds_won"] - d["rounds_lost"]) / n if n else 0.0
        # score de force en logit : victoire lissée + écart de rounds (≈ 0,05 logit par round d'écart moyen)
        d["strength"] = round(math.log(smoothed / (1 - smoothed)) + 0.05 * rd, 3)
    return out


def veto_data(session: Session, team_a: int, team_b: int, maps: list[str]) -> dict | None:
    ta, tb = session.get(Team, team_a), session.get(Team, team_b)
    if ta is None or tb is None:
        return None
    a, b = _team_maps(session, team_a), _team_maps(session, team_b)
    empty = {"played": 0, "won": 0, "rounds_won": 0, "rounds_lost": 0, "win_pct": 0.0, "strength": 0.0}
    va, vb = _veto_rates(session, team_a, maps), _veto_rates(session, team_b, maps)
    rows = []
    for name in maps:
        sa, sb = a.get(name, empty), b.get(name, empty)
        adv = sa["strength"] - sb["strength"]
        rows.append({"map": name, "a": {**sa, **va["maps"][name]}, "b": {**sb, **vb["maps"][name]}, "advantage": round(adv, 3),
                     "p_a": round(1 / (1 + math.exp(-adv)), 3)})  # probabilité estimée que A gagne la carte
    h2h = [m for m in session.scalars(select(Match).where(
        ((Match.team_a_id == team_a) & (Match.team_b_id == team_b)) | ((Match.team_a_id == team_b) & (Match.team_b_id == team_a))))]
    return {"team_a": {"id": ta.id, "name": ta.name}, "team_b": {"id": tb.id, "name": tb.name}, "maps": rows, "vetos": {"a": va["vetos"], "b": vb["vetos"]},
            "head_to_head": [{"match_id": m.id, "map": m.map_name,
                              "score": [m.score_a, m.score_b] if m.team_a_id == team_a else [m.score_b, m.score_a]} for m in h2h]}
