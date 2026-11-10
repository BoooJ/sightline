# backend/app/stats/career_extra.py
"""Agrégats de carrière issus de l'analyse automatique : impact (probabilité de victoire), morts évitables, raisons
de mort et visée, par joueur, sur toute la bibliothèque (ou une sélection de matchs)."""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.stats.aim import combine_aim
from app.stats.analysis import REASONS, match_analysis
from app.storage.models import Match


def career_extras(session: Session, match_ids: set[int] | None = None, analysis=match_analysis) -> dict[str, dict]:
    ids = [m for m in session.scalars(select(Match.id)) if match_ids is None or m in match_ids]
    acc: dict[str, dict] = defaultdict(lambda: {"impact_sum": 0.0, "rounds": 0, "deaths": 0, "avoidable": 0,
                                                "unused_utility": 0, "reasons": defaultdict(int), "matches": 0, "aim": [],
                                                "duels": defaultdict(lambda: [0, 0]), "dry": [0, 0]})
    for mid in ids:
        a = analysis(session, mid)
        if a is None:
            continue
        for p in a["players"]:
            o = acc[p["steamid"]]
            o["impact_sum"] += p["impact"] * p["rounds"]
            o["rounds"] += p["rounds"]
            o["deaths"] += p["deaths"]
            o["avoidable"] += p["avoidable"]
            o["unused_utility"] += p["unused_utility"]
            o["matches"] += 1
            o["aim"].append(p.get("aim"))
            for k, v in p["reasons"].items():
                o["reasons"][k] += v
            for z, (w, l) in (p.get("duels") or {}).items():
                o["duels"][z][0] += w
                o["duels"][z][1] += l
            for i, v in enumerate(p.get("dry") or (0, 0)):
                o["dry"][i] += v
    out = {}
    for sid, o in acc.items():
        r = max(1, o["rounds"])
        out[sid] = {
            "impact": round(o["impact_sum"] / r, 1), "rounds": o["rounds"], "matches": o["matches"],
            "avoidable_pr": round(o["avoidable"] / r, 3), "avoidable_pct": round(100 * o["avoidable"] / o["deaths"], 1) if o["deaths"] else 0.0,
            "unused_utility_pr": round(o["unused_utility"] / r), "reasons": {k: o["reasons"].get(k, 0) for k in REASONS},
            "duels": dict(o["duels"]), "dry": o["dry"], "deaths": o["deaths"], "aim": combine_aim(o["aim"]),
        }
    return out
