# backend/app/stats/aim.py
"""Statistiques de visée : précision, précision de la première balle, headshots touchés, tirs à l'arrêt
(contre-strafe) et temps pour tuer.

Un tir touche s'il existe des dégâts du même tireur sur un adversaire au même tick (les armes à feu sont instantanées).
Première balle : tir précédé d'au moins FIRST_GAP_S sans tirer. À l'arrêt : vitesse horizontale au tir sous 34 % de la
vitesse maximale de l'arme, seuil sous lequel CS2 applique la précision « debout »."""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.models import Damage, Kill, Match, Round, Shot

FIRST_GAP_S = 0.5
TTK_WINDOW_S = 3.0
NON_GUN = ("hegrenade", "inferno", "molotov", "incgrenade", "flashbang", "smokegrenade", "decoy", "knife", "bayonet",
           "taser", "world", "planted_c4", "")
MAX_SPEED = {"ak47": 215, "m4a1": 225, "m4a1_silencer": 225, "famas": 220, "galilar": 215, "aug": 220, "sg556": 210,
             "awp": 200, "ssg08": 230, "g3sg1": 215, "scar20": 215, "glock": 240, "usp_silencer": 240, "hkp2000": 240,
             "p250": 240, "tec9": 240, "fiveseven": 240, "cz75a": 240, "deagle": 230, "revolver": 220, "elite": 240,
             "mp9": 240, "mac10": 240, "mp7": 220, "mp5sd": 235, "ump45": 230, "p90": 230, "bizon": 240,
             "nova": 220, "xm1014": 215, "mag7": 225, "sawedoff": 210, "negev": 150, "m249": 195}


def _gun(w: str) -> bool:
    return not any(w.startswith(x) for x in NON_GUN if x) and w != ""


def aim_stats(session: Session, round_ids: list[int] | None = None) -> dict[str, dict]:
    """Statistiques de visée par joueur (steamid) sur les rounds donnés (tous si None)."""
    if round_ids is not None and not round_ids:
        return {}
    flt = (lambda m: m.round_id.in_(round_ids)) if round_ids is not None else (lambda m: True)
    tickrate = dict(session.execute(select(Round.id, Match.demo_tickrate).join(Match, Match.id == Round.match_id)).all())
    hits: dict[tuple[int, str, int], bool] = {}  # (round, tireur, tick) -> au moins un headshot
    dmg_first: dict[tuple[int, str, str], list[int]] = defaultdict(list)
    for d in session.scalars(select(Damage).where(flt(Damage))):
        if not d.attacker or d.attacker == d.victim or d.attacker_side == d.victim_side or not _gun(d.weapon):
            continue
        k = (d.round_id, d.attacker, d.tick)
        hits[k] = hits.get(k, False) or d.hitgroup == "head"
        dmg_first[(d.round_id, d.attacker, d.victim)].append(d.tick)
    out: dict[str, dict] = defaultdict(lambda: {"shots": 0, "hits": 0, "head_hits": 0, "first": 0, "first_hits": 0,
                                                 "first_speed": 0, "still": 0, "ttk": []})
    last: dict[tuple[int, str], int] = {}
    for s in session.scalars(select(Shot).where(flt(Shot)).order_by(Shot.round_id, Shot.shooter, Shot.tick)):
        if not _gun(s.weapon):
            continue
        o = out[s.shooter]
        tr = tickrate.get(s.round_id, 64)
        hit = (s.round_id, s.shooter, s.tick) in hits
        o["shots"] += 1
        o["hits"] += hit
        o["head_hits"] += hit and hits[(s.round_id, s.shooter, s.tick)]
        prev = last.get((s.round_id, s.shooter))
        last[(s.round_id, s.shooter)] = s.tick
        if prev is None or s.tick - prev > FIRST_GAP_S * tr:
            o["first"] += 1
            o["first_hits"] += hit
            if s.speed is not None:
                o["first_speed"] += 1
                o["still"] += s.speed <= 0.34 * MAX_SPEED.get(s.weapon, 230)
    for k in session.scalars(select(Kill).where(flt(Kill))):
        if not k.attacker or k.attacker == k.victim or k.attacker_side == k.victim_side or not _gun(k.weapon):
            continue
        tr = tickrate.get(k.round_id, 64)
        ticks = [t for t in dmg_first.get((k.round_id, k.attacker, k.victim), []) if k.tick - TTK_WINDOW_S * tr <= t <= k.tick]
        if ticks:
            out[k.attacker]["ttk"].append((k.tick - min(ticks)) / tr)
    return {sid: _finish({**{k: v for k, v in o.items() if k != "ttk"}, "ttk_sum": sum(o["ttk"]), "ttk_kills": len(o["ttk"])})
            for sid, o in out.items()}


COUNTERS = ("shots", "hits", "head_hits", "first", "first_hits", "first_speed", "still", "ttk_sum", "ttk_kills")


def _finish(c: dict) -> dict:
    pct = lambda a, b: round(100 * a / b, 1) if b else None  # noqa: E731
    return {
        "shots": c["shots"], "accuracy": pct(c["hits"], c["shots"]), "hs_accuracy": pct(c["head_hits"], c["hits"]),
        "first_bullet": pct(c["first_hits"], c["first"]), "counter_strafe": pct(c["still"], c["first_speed"]),
        "ttk_ms": round(1000 * c["ttk_sum"] / c["ttk_kills"]) if c["ttk_kills"] else None, "ttk_kills": c["ttk_kills"],
        "counters": {k: c[k] for k in COUNTERS},  # compteurs bruts : les stats de plusieurs matchs s'additionnent
    }


def combine_aim(parts: list[dict]) -> dict | None:
    """Stats de visée de plusieurs matchs, à partir de leurs compteurs bruts."""
    parts = [p for p in parts if p and p.get("counters")]
    if not parts:
        return None
    return _finish({k: sum(p["counters"][k] for p in parts) for k in COUNTERS})
