# backend/app/stats/positions.py
"""Rôles EDGE et postes de carte.

Pour chaque joueur, par carte et par camp, on regarde où il est à un instant de référence de chaque round :
- T, de 15 à 45 s après le freeze time (le default se met en place) : le lieu dominant (callout) et la distance moyenne
  au coéquipier vivant le plus proche → par round, isolé (> 900 u), à l'écart (> 500 u) ou groupé ; Lurk si isolé dans
  ≥ 40 % des rounds, Demi-lurk si isolé ou à l'écart dans ≥ 40 %, Pack si groupé dans ≥ 60 %, sinon « T polyvalent » ;
- CT, de 10 à 30 s : le lieu dominant ; Ancre s'il tient le même lieu dans ≥ 60 % des rounds, Rotation si son lieu de
  départ varie (aucun lieu ≥ 35 %), sinon « CT polyvalent ».
Le poste est le lieu le plus fréquent s'il couvre ≥ 35 % des rounds. Petits échantillons : rien en dessous de 6
rounds (le poste et le rôle restent vides)."""
from __future__ import annotations

import math
from collections import Counter, defaultdict

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.parsing.model import FLAG_ALIVE
from app.stats.places import place_markers, place_of
from app.stats.roles import SITE_R, site_centers
from app.storage.frames_codec import decode_fields
from app.storage.models import Match, Round, RoundFrames

T_WIN, CT_WIN, CT_LATE_S = (15, 45), (10, 30), 50   # fenêtres d'observation (s après le freeze time)
MIN_ROUNDS = 6
LURK_D, HALF_D = 900.0, 500.0         # distance moyenne au coéquipier vivant le plus proche (par round)
LURK_SHARE, PACK_SHARE = 0.40, 0.60    # part des rounds isolé (lurk, demi-lurk) / groupé (pack)
POSTE_MIN_SHARE, ANCHOR_SHARE, ROTATION_MAX_SHARE = 0.35, 0.60, 0.35
# boucle par image en Python (lieu dominant, distance au coéquipier) : au plus 16 images par seconde lues ; une démo à
# 32 i/s n'y coûte pas le double, et une démo à 16 i/s donne exactement les mêmes résultats
MAX_FPS = 16
EDGE_ROLE_LABELS = {"lurk": "Lurk", "half_lurk": "Demi-lurk", "pack": "Pack", "t_allround": "T polyvalent",
                    "anchor": "Ancre", "rotation": "Rotation", "ct_allround": "CT polyvalent"}
EDGE_ROLES_T = ("lurk", "half_lurk", "pack", "t_allround")
EDGE_ROLES_CT = ("anchor", "rotation", "ct_allround")


def _empty(n: int = 0) -> dict:
    return {"role": None, "poste": None, "rounds": n, "places": {}}


def _poste(places: Counter, n: int) -> str | None:
    if not places:
        return None
    place, k = places.most_common(1)[0]
    return place if k / n >= POSTE_MIN_SHARE else None


def _agg_t(items: list[tuple[str | None, float | None]]) -> dict:
    """items : (lieu dominant 15–45 s, distance moyenne au coéquipier le plus proche sur la fenêtre)."""
    n = len(items)
    if n < MIN_ROUNDS:
        return _empty(n)
    ds = [d for _, d in items if d is not None]
    lurk = sum(1 for d in ds if d > LURK_D) / n
    half = sum(1 for d in ds if HALF_D < d <= LURK_D) / n
    pack = sum(1 for d in ds if d <= HALF_D) / n
    if lurk >= LURK_SHARE:
        role = "lurk"
    elif lurk + half >= LURK_SHARE:
        role = "half_lurk"
    elif pack >= PACK_SHARE:
        role = "pack"
    else:
        role = "t_allround"
    places = Counter(p for p, _ in items if p)
    return {"role": role, "poste": _poste(places, n), "rounds": n, "places": dict(places.most_common(6)),
            "lurk_share": round(lurk + half, 2)}


def _agg_ct(items: list[tuple[str | None, str | None, str | None]]) -> dict:
    """items : (lieu dominant 10–30 s, site le plus proche à 20 s, lieu à 50 s)."""
    n = len(items)
    if n < MIN_ROUNDS:
        return _empty(n)
    places = Counter(p for p, _, _ in items if p)
    late = [(p, q) for p, _, q in items if p and q]
    stay = sum(1 for p, q in late if p == q) / len(late) if late else 0.0
    top_share = places.most_common(1)[0][1] / n if places else 0.0
    # ancre : tient le même lieu dans la moitié des rounds au moins ; rotation : lieu de départ très variable
    role = "anchor" if top_share >= ANCHOR_SHARE else "rotation" if top_share < ROTATION_MAX_SHARE else "ct_allround"
    return {"role": role, "poste": _poste(places, n), "rounds": n, "places": dict(places.most_common(6)), "stay": round(stay, 2)}


def _nearest_site(sites: dict, x: float, y: float, z: float) -> str | None:
    best, bd = None, None
    for k, c in sites.items():
        d = float(np.hypot(x - c[0], y - c[1]))
        if c[2] is not None:
            d = float(np.hypot(d, 2 * (z - c[2])))
        if d <= SITE_R and (bd is None or d < bd):
            best, bd = k, d
    return best


def player_positions(session: Session, maps: dict[str, MapMeta], map_name: str | None = None,
                     match_ids: set[int] | None = None) -> dict[str, dict]:
    """{steamid: {"T": agg, "CT": agg, "maps": {map: {"T", "CT"}}, "matches": {match_id: {"T", "CT"}}}}.
    `T` / `CT` : la carte filtrée, ou, toutes cartes, la carte où le joueur a le plus de rounds dans ce camp
    (champ `map`)."""
    q = select(Match).order_by(Match.id)
    if map_name:
        q = q.where(Match.map_name == map_name)
    t_items: dict[tuple, list] = defaultdict(list)    # (sid, map, match) -> [(place, mate_dist)]
    ct_items: dict[tuple, list] = defaultdict(list)   # (sid, map, match) -> [(place20, site, place50)]
    markers: dict[str, list] = {}
    sites: dict[str, dict] = {}
    round_place: dict[tuple, str | None] = {}   # (sid, round_id) -> lieu dominant
    for m in session.scalars(q):
        if match_ids is not None and m.id not in match_ids:
            continue
        meta = maps.get(m.map_name)
        if meta is None:
            continue
        if m.map_name not in markers:
            markers[m.map_name] = place_markers(session, meta)
            sites[m.map_name] = site_centers(session, maps, m.map_name)
        team_of = {mp.steamid: mp.team_id for mp in m.players}
        rate = m.demo_tickrate or 64
        every = max(1, math.ceil((m.sample_rate or MAX_FPS) / MAX_FPS))  # 16 i/s : toutes les images ; 32 : une sur deux
        for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
            fr = session.get(RoundFrames, r.id)
            if fr is None:
                continue
            fd = decode_fields(fr.blob, ("x", "y", "z", "flags"))
            ticks = fd.ticks
            win = {}
            for key, (a, b) in (("t", T_WIN), ("ct", CT_WIN)):
                lo = int(np.searchsorted(ticks, r.freeze_end_tick + a * rate))
                hi = int(np.searchsorted(ticks, min(r.end_tick, r.freeze_end_tick + b * rate), side="right"))
                win[key] = (lo, hi) if hi > lo else None
            i50 = int(np.searchsorted(ticks, r.freeze_end_tick + CT_LATE_S * rate))
            i50 = i50 if i50 < len(ticks) and ticks[i50] <= r.end_tick else None
            side_of = {sid: ("CT" if tid == r.ct_team_id else "T") for sid, tid in team_of.items()}
            players = list(fd.players)
            alive = (fd.fields["flags"] & FLAG_ALIVE) > 0
            X, Y, Z = fd.fields["x"], fd.fields["y"], fd.fields["z"]
            mk, st = markers[m.map_name], sites[m.map_name]

            def dominant(j: int, lo: int, hi: int) -> str | None:
                c = Counter(place_of(meta, mk, float(X[i, j]), float(Y[i, j]), float(Z[i, j])) for i in range(lo, hi, every) if alive[i, j])
                c.pop(None, None)
                return c.most_common(1)[0][0] if c else None

            for j, sid in enumerate(players):
                s_ = side_of.get(sid)
                if s_ is None:
                    continue
                if s_ == "T":
                    if win["t"] is None:
                        continue
                    lo, hi = win["t"]
                    if not alive[lo:hi, j].any():
                        continue
                    mates = [k for k, o in enumerate(players) if k != j and side_of.get(o) == "T"]
                    ds = []
                    for i in range(lo, hi, every):
                        if not alive[i, j]:
                            continue
                        dd = [float(np.hypot(X[i, k] - X[i, j], Y[i, k] - Y[i, j])) for k in mates if alive[i, k]]
                        if dd:
                            ds.append(min(dd))
                    pl = dominant(j, lo, hi)
                    t_items[(sid, m.map_name, m.id)].append((pl, float(np.mean(ds)) if ds else None))
                    round_place[(sid, r.id)] = pl
                else:
                    if win["ct"] is None:
                        continue
                    lo, hi = win["ct"]
                    if not alive[lo:hi, j].any():
                        continue
                    mid_i = min(hi - 1, (lo + hi) // 2)
                    site = _nearest_site(st, float(X[mid_i, j]), float(Y[mid_i, j]), float(Z[mid_i, j])) if alive[mid_i, j] else None
                    p50 = place_of(meta, mk, float(X[i50, j]), float(Y[i50, j]), float(Z[i50, j])) if i50 is not None and alive[i50, j] else None
                    pl = dominant(j, lo, hi)
                    ct_items[(sid, m.map_name, m.id)].append((pl, site, p50))
                    round_place[(sid, r.id)] = pl

    out: dict[str, dict] = {}
    by_sid_map: dict[tuple, dict] = defaultdict(lambda: {"T": [], "CT": []})
    by_sid_match: dict[tuple, dict] = defaultdict(lambda: {"T": [], "CT": []})
    for (sid, mp, mid), items in t_items.items():
        by_sid_map[(sid, mp)]["T"] += items
        by_sid_match[(sid, mid)]["T"] += items
    for (sid, mp, mid), items in ct_items.items():
        by_sid_map[(sid, mp)]["CT"] += items
        by_sid_match[(sid, mid)]["CT"] += items
    for (sid, mp), d in by_sid_map.items():
        o = out.setdefault(sid, {"T": _empty(), "CT": _empty(), "maps": {}, "matches": {}})
        o["maps"][mp] = {"T": _agg_t(d["T"]), "CT": _agg_ct(d["CT"])}
    for (sid, mid), d in by_sid_match.items():
        out[sid]["matches"][mid] = {"T": _agg_t(d["T"]), "CT": _agg_ct(d["CT"])}
    for sid, o in out.items():
        for side in ("T", "CT"):
            best = max(o["maps"].items(), key=lambda kv: kv[1][side]["rounds"], default=None)
            if best:
                o[side] = {**best[1][side], "map": best[0]}
    for (sid, rid), pl in round_place.items():
        if sid in out:
            out[sid].setdefault("round_place", {})[rid] = pl
    return out
