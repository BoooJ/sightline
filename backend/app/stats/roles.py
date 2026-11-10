# backend/app/stats/roles.py
"""Détection des rôles par heuristiques (équivalent de la « détection IA des rôles » d'EDGE).

Indicateurs par joueur et par camp, calculés sur les rounds du joueur :
- part des kills à l'AWP ;
- T : duels d'ouverture par round, distance moyenne au coéquipier vivant le plus proche (0–40 s après le freeze time),
  utilitaires lancés par round ;
- CT : part du temps passé près de chaque site de bombe (0–40 s), centres de site tirés des poses réelles.
Les rôles sont ensuite attribués **au sein de chaque équipe** (le joueur le plus marqué sur chaque indicateur)."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.parsing.model import FLAG_ALIVE
from app.storage.frames_codec import decode_fields
from app.storage.models import BombEvent, Grenade, Kill, Match, Round, RoundFrames

WINDOW_S = 40
SITE_R = 900.0  # unités de jeu : « près d'un site »
AWP_MIN = 0.25
ANCHOR_MIN = 0.75
NEAR_MIN = 0.25
ROLE_LABELS = {"awper": "AWPer", "entry": "Entry", "lurker": "Lurker", "support": "Support", "rifler": "Rifler",
               "anchor_a": "Ancre A", "anchor_b": "Ancre B", "rotator": "Rotateur"}


@dataclass
class _F:
    kills: int = 0
    awp_kills: int = 0
    rounds: dict = field(default_factory=lambda: {"CT": 0, "T": 0})
    openings_t: int = 0
    util_t: int = 0
    dist_sum: float = 0.0
    dist_n: int = 0
    near: dict = field(default_factory=lambda: {"A": 0, "B": 0})
    ct_samples: int = 0


def _site_world(m: MapMeta, rel) -> tuple[float, float, float | None] | None:
    if rel is None:
        return None
    return m.pos_x + rel[0] * 1024 * m.scale, m.pos_y - rel[1] * 1024 * m.scale, None


def site_centers(session: Session, maps: dict[str, MapMeta], map_name: str) -> dict[str, tuple]:
    """Centre 3D de chaque site : moyenne des positions de pose réelles de la bibliothèque (indispensable sur les
    cartes à sites superposés comme Nuke), sinon position 2D de l'overview."""
    pts: dict[str, list] = defaultdict(list)
    q = (select(BombEvent).join(Round, Round.id == BombEvent.round_id).join(Match, Match.id == Round.match_id)
         .where(Match.map_name == map_name, BombEvent.type == "plant", BombEvent.x.is_not(None)))
    for b in session.scalars(q):
        if b.site in ("A", "B"):
            pts[b.site].append((b.x, b.y, b.z))
    meta = maps.get(map_name)
    out = {}
    for k in ("A", "B"):
        if pts[k]:
            a = np.array(pts[k])
            out[k] = (float(a[:, 0].mean()), float(a[:, 1].mean()), float(a[:, 2].mean()))
        elif meta:
            c = _site_world(meta, getattr(meta, f"bomb_{k.lower()}"))
            if c:
                out[k] = c
    return out


def detect_roles(session: Session, maps: dict[str, MapMeta], map_name: str | None = None) -> dict[str, dict]:
    """{steamid: {"t": role, "ct": role, "features": {...}}} sur les matchs (filtrés par carte)."""
    q = select(Match)
    if map_name:
        q = q.where(Match.map_name == map_name)
    feats: dict[str, _F] = defaultdict(_F)
    team_of_last: dict[str, int] = {}
    centers: dict[str, dict] = {}
    for m in session.scalars(q):
        if m.map_name not in centers:
            centers[m.map_name] = site_centers(session, maps, m.map_name)
        sites = centers[m.map_name]
        team_of = {mp.steamid: mp.team_id for mp in m.players}
        team_of_last.update(team_of)
        rounds = list(session.scalars(select(Round).where(Round.match_id == m.id)))
        rids = [r.id for r in rounds]
        for k in session.scalars(select(Kill).where(Kill.round_id.in_(rids))):
            if k.attacker and k.attacker in team_of and team_of.get(k.victim) != team_of[k.attacker]:
                feats[k.attacker].kills += 1
                feats[k.attacker].awp_kills += k.weapon == "awp"
        first_kill: dict[int, Kill] = {}
        for k in session.scalars(select(Kill).where(Kill.round_id.in_(rids)).order_by(Kill.tick)):
            if k.attacker and team_of.get(k.attacker) not in (None, team_of.get(k.victim)):
                first_kill.setdefault(k.round_id, k)
        nades = defaultdict(int)
        for g in session.scalars(select(Grenade).where(Grenade.round_id.in_(rids))):
            nades[(g.round_id, g.thrower)] += 1
        for r in rounds:
            side_of = {sid: ("CT" if tid == r.ct_team_id else "T") for sid, tid in team_of.items()}
            for sid, s in side_of.items():
                feats[sid].rounds[s] += 1
                if s == "T":
                    feats[sid].util_t += nades[(r.id, sid)]
            fk = first_kill.get(r.id)
            if fk:
                for who in (fk.attacker, fk.victim):
                    if side_of.get(who) == "T":
                        feats[who].openings_t += 1
            fr = session.get(RoundFrames, r.id)
            if fr is None:
                continue
            fd = decode_fields(fr.blob)
            sel = (fd.ticks >= r.freeze_end_tick) & (fd.ticks <= r.freeze_end_tick + WINDOW_S * m.demo_tickrate)
            if not sel.any():
                continue
            x, y, z = fd.fields["x"][sel], fd.fields["y"][sel], fd.fields["z"][sel]
            alive = (fd.fields["flags"][sel] & FLAG_ALIVE) > 0
            sides = np.array([side_of.get(sid, "?") for sid in fd.players])
            for j, sid in enumerate(fd.players):
                s = side_of.get(sid)
                if s is None:
                    continue
                a = alive[:, j]
                if not a.any():
                    continue
                if s == "T":
                    mates = [i for i in range(len(fd.players)) if i != j and sides[i] == "T"]
                    if mates:
                        d = np.hypot(x[:, mates] - x[:, [j]], y[:, mates] - y[:, [j]])
                        d = np.where(alive[:, mates], d, np.inf).min(axis=1)
                        ok = a & np.isfinite(d)
                        feats[sid].dist_sum += float(d[ok].sum())
                        feats[sid].dist_n += int(ok.sum())
                else:
                    feats[sid].ct_samples += int(a.sum())
                    # chaque échantillon compte pour le site le plus proche seulement (sites voisins : Nuke, Vertigo…)
                    dists = {}
                    for k_, c in sites.items():
                        d = np.hypot(x[:, j] - c[0], y[:, j] - c[1])
                        if c[2] is not None:  # sites superposés : la hauteur compte (×2 : un étage ≈ 300 u)
                            d = np.hypot(d, 2 * (z[:, j] - c[2]))
                        dists[k_] = d
                    for k_, d in dists.items():
                        closest = np.all([d <= o for kk, o in dists.items() if kk != k_], axis=0) if len(dists) > 1 else True
                        feats[sid].near[k_] += int((a & (d <= SITE_R) & closest).sum())

    def metrics(f: _F) -> dict:
        tr = max(1, f.rounds["T"])
        return {"awp_share": round(f.awp_kills / f.kills, 3) if f.kills else 0.0,
                "t_opening_rate": round(f.openings_t / tr, 3), "t_util_per_round": round(f.util_t / tr, 2),
                "t_teammate_dist": round(f.dist_sum / f.dist_n) if f.dist_n else 0,
                "ct_near_a": round(f.near["A"] / f.ct_samples, 3) if f.ct_samples else 0.0,
                "ct_near_b": round(f.near["B"] / f.ct_samples, 3) if f.ct_samples else 0.0}

    out = {sid: {"features": metrics(f), "t": "rifler", "ct": "rotator"} for sid, f in feats.items()}
    by_team: dict[int, list[str]] = defaultdict(list)
    for sid in out:
        if sid in team_of_last:
            by_team[team_of_last[sid]].append(sid)
    for members in by_team.values():
        mt = {sid: out[sid]["features"] for sid in members}
        awper = max(members, key=lambda s: mt[s]["awp_share"])
        rest = list(members)
        if mt[awper]["awp_share"] >= AWP_MIN:
            out[awper]["t"] = out[awper]["ct"] = "awper"
            rest.remove(awper)
        for role, key in (("entry", "t_opening_rate"), ("lurker", "t_teammate_dist"), ("support", "t_util_per_round")):
            if rest:
                best = max(rest, key=lambda s: mt[s][key])
                if mt[best][key] > 0:
                    out[best]["t"] = role
                    rest.remove(best)
        for sid in members:
            if out[sid]["ct"] == "awper":
                continue
            a, b = mt[sid]["ct_near_a"], mt[sid]["ct_near_b"]
            # ancre : souvent près d'un site (≥ 25 % du temps), et presque toujours le même (≥ 75 % de ce temps)
            near = a + b
            dom = max(a, b) / near if near else 0
            out[sid]["ct"] = ("anchor_a" if a >= b else "anchor_b") if near >= NEAR_MIN and dom >= ANCHOR_MIN else "rotator"
    return out
