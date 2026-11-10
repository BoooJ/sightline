# backend/app/stats/grenades.py
"""Bibliothèque de grenades (sous-projet 4) : lancers filtrés sur toute la bibliothèque et regroupement en lineups.

Un lineup = même type de grenade, lancée depuis le même endroit (≤ THROW_R unités) et atterrissant au même endroit
(≤ LAND_R unités). La commande `setpos/setang` reprend la position du joueur et ses angles de vue au lancer."""
from __future__ import annotations

import math
from functools import lru_cache

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.frames_codec import unpack
from app.storage.models import Grenade, Match, MatchPlayer, Round

THROW_R = 48.0
LAND_R = 160.0
TYPES = ("smoke", "flash", "he", "molotov", "incendiary", "decoy")


def _thin(traj: list, n: int = 24) -> list[list[int]]:
    """Trajectoire allégée pour l'affichage (≤ n points, coordonnées entières)."""
    step = max(1, math.ceil(len(traj) / n))
    pts = traj[::step]
    if pts[-1] is not traj[-1]:
        pts.append(traj[-1])
    return [[round(x), round(y), round(z)] for _, x, y, z in pts]


@lru_cache(maxsize=20000)
def _trajectory(blob: bytes) -> tuple[list[list[int]], tuple[float, float, float] | None]:
    """Trajectoire allégée et dernier point, mis en cache par contenu (le décodage msgpack domine la recherche)."""
    traj = unpack(blob)
    return (_thin(traj), tuple(traj[-1][1:4])) if traj else ([], None)


def setpos(g: Grenade) -> str | None:
    if g.throw_yaw is None or g.throw_pitch is None:
        return None
    return (f"setpos {g.throw_x:.2f} {g.throw_y:.2f} {g.throw_z:.2f};"
            f"setang {g.throw_pitch:.2f} {g.throw_yaw:.2f} 0")


def search_grenades(session: Session, map_name: str, types: list[str] | None = None, side: str | None = None,
                    team: int | None = None, player: str | None = None, match: int | None = None,
                    limit: int = 3000) -> dict:
    stmt = (select(Grenade, Round, Match).join(Round, Round.id == Grenade.round_id).join(Match, Match.id == Round.match_id)
            .where(Match.map_name == map_name).order_by(Match.id.desc(), Grenade.throw_tick))
    if types:
        stmt = stmt.where(Grenade.type.in_(types))
    if player:
        stmt = stmt.where(Grenade.thrower == player)
    if match:
        stmt = stmt.where(Match.id == match)
    players = {(mp.match_id, mp.steamid): mp for mp in session.scalars(
        select(MatchPlayer).join(Match, Match.id == MatchPlayer.match_id).where(Match.map_name == map_name))}
    teams: dict[int, str] = {}
    throws = []
    for g, r, m in session.execute(stmt):
        mp = players.get((m.id, g.thrower))
        if mp is None:
            continue
        g_side = "CT" if mp.team_id == r.ct_team_id else "T"
        if side and g_side != side or team and mp.team_id != team:
            continue
        if mp.team_id not in teams:
            teams[mp.team_id] = m.team_a.name if m.team_a_id == mp.team_id else m.team_b.name
        land = (g.detonate_x, g.detonate_y, g.detonate_z) if g.detonate_x is not None else None
        thin, last = _trajectory(g.trajectory)
        if land is None:
            land = last
        throws.append({
            "id": g.id, "type": g.type, "side": g_side, "thrower": g.thrower, "thrower_name": mp.name_in_match,
            "team_id": mp.team_id, "team": teams[mp.team_id], "match_id": m.id, "round_number": r.number,
            "round_id": r.id, "throw_tick": g.throw_tick, "detonate_tick": g.detonate_tick,
            "throw": [round(g.throw_x), round(g.throw_y), round(g.throw_z)],
            "land": [round(land[0]), round(land[1]), round(land[2])] if land else None,
            "yaw": g.throw_yaw, "pitch": g.throw_pitch, "setpos": setpos(g),
            "trajectory": thin,
            "opponent": m.team_b.name if m.team_a_id == mp.team_id else m.team_a.name,
            # round gagné par le camp du lanceur, et moment du lancer après la fin du freeze time (combinaisons)
            "won": None if r.winner_side is None else r.winner_side == g_side,
            "time_s": round((g.throw_tick - r.freeze_end_tick) / (m.demo_tickrate or 64), 1),
        })
        if len(throws) >= limit:
            break
    return {"throws": throws, "lineups": cluster(throws)}


def cluster(throws: list[dict]) -> list[dict]:
    """Regroupement glouton : chaque lancer rejoint le premier lineup compatible (type, départ, arrivée)."""
    groups: list[dict] = []
    for t in throws:
        if t["land"] is None:
            continue
        for gr in groups:
            if gr["type"] == t["type"] and gr["side"] == t["side"] \
                    and math.dist(gr["throw"][:2], t["throw"][:2]) <= THROW_R \
                    and math.dist(gr["land"][:2], t["land"][:2]) <= LAND_R:
                gr["ids"].append(t["id"])
                gr["players"].add(t["thrower_name"])
                break
        else:
            groups.append({"type": t["type"], "side": t["side"], "throw": t["throw"], "land": t["land"],
                           "ids": [t["id"]], "players": {t["thrower_name"]}, "setpos": t["setpos"],
                           "trajectory": t["trajectory"]})
    out = [{**g, "count": len(g["ids"]), "players": sorted(g["players"], key=str.lower)} for g in groups]
    out.sort(key=lambda g: -g["count"])
    for k, g in enumerate(out):
        g["key"] = k
    return out
