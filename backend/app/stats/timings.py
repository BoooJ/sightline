# backend/app/stats/timings.py
"""Carte des timings d'une équipe sur une carte : à quel moment du round (secondes après le freeze time) elle
arrive dans chaque zone, et où sont ses joueurs toutes les 5 s. Filtrable par camp et par tactique du playbook.

Zones : lieux de la carte (callouts du jeu) situés par le centre des morts qui s'y sont produites ; chaque position
est rattachée au lieu le plus proche (même niveau, 700 unités au plus)."""
from __future__ import annotations

from collections import defaultdict

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta, level_for_z
from app.parsing.model import FLAG_ALIVE
from app.storage.frames_codec import decode_fields
from app.storage.models import Kill, Match, MatchPlayer, Round, RoundFrames

MAX_S = 90       # fenêtre étudiée après le freeze time
SLICE_S = 5      # pas des instantanés de positions
BIN_S = 5        # pas de l'histogramme des arrivées
ZONE_R = 700.0   # distance maximale au centre d'un lieu
MIN_KILLS = 3    # un lieu doit avoir vu quelques morts pour servir de repère


def place_centers(session: Session, meta: MapMeta) -> dict[str, tuple[float, float, float]]:
    rows = session.execute(
        select(Kill.victim_place, func.avg(Kill.victim_x), func.avg(Kill.victim_y), func.avg(Kill.victim_z), func.count())
        .join(Round, Round.id == Kill.round_id).join(Match, Match.id == Round.match_id)
        .where(Match.map_name == meta.name, Kill.victim_place.is_not(None)).group_by(Kill.victim_place))
    return {p: (x, y, z) for p, x, y, z, n in rows if n >= MIN_KILLS}


def team_timings(session: Session, maps: dict[str, MapMeta], team_id: int, map_name: str, side: str,
                 round_ids: set[int] | None = None) -> dict:
    meta = maps[map_name]
    centers = place_centers(session, meta)
    names = list(centers)
    cx = np.array([centers[p][0] for p in names], dtype=np.float64)
    cy = np.array([centers[p][1] for p in names], dtype=np.float64)
    clevel = np.array([level_for_z(meta, centers[p][2]) for p in names])
    first: dict[str, list[float]] = defaultdict(list)   # lieu -> première arrivée, une valeur par round atteint
    crowd: dict[str, list[int]] = defaultdict(list)     # lieu -> nb de joueurs passés par là, par round atteint
    slices: dict[int, list[list[float]]] = {s: [] for s in range(0, MAX_S + 1, SLICE_S)}
    analysed = []
    matches = session.scalars(select(Match).where(Match.map_name == map_name,
                                                  (Match.team_a_id == team_id) | (Match.team_b_id == team_id)))
    for m in matches:
        mine = {mp.steamid for mp in session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id,
                                                                                MatchPlayer.team_id == team_id))}
        rate = m.demo_tickrate or 64
        for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
            if ("CT" if r.ct_team_id == team_id else "T") != side or (round_ids is not None and r.id not in round_ids):
                continue
            fr = session.get(RoundFrames, r.id)
            if fr is None:
                continue
            ff = decode_fields(fr.blob, ("x", "y", "z", "flags"))
            cols = [j for j, sid in enumerate(ff.players) if sid in mine]
            if not cols:
                continue
            t0 = r.freeze_end_tick
            secs = (ff.ticks - t0) / rate
            win = np.where((secs >= 0) & (secs <= MAX_S) & (ff.ticks <= r.end_tick))[0]
            if not len(win):
                continue
            analysed.append({"round_id": r.id, "match_id": m.id, "number": r.number, "won": r.winner_side == side})
            if names:
                x = ff.fields["x"][np.ix_(win, cols)].astype(np.float64)
                y = ff.fields["y"][np.ix_(win, cols)].astype(np.float64)
                z = ff.fields["z"][np.ix_(win, cols)]
                alive = (ff.fields["flags"][np.ix_(win, cols)] & FLAG_ALIVE) > 0
                d = np.hypot(x[..., None] - cx, y[..., None] - cy)             # (images, joueurs, lieux)
                lvl = np.vectorize(lambda v: level_for_z(meta, float(v)))(z) if len(meta.levels) > 1 else None
                if lvl is not None:
                    d = np.where(lvl[..., None] == clevel, d, np.inf)
                zone = np.argmin(d, axis=2)
                ok = alive & (np.take_along_axis(d, zone[..., None], axis=2)[..., 0] <= ZONE_R)
                for k, p in enumerate(names):
                    hit = ok & (zone == k)
                    if hit.any():
                        i = int(np.argmax(hit.any(axis=1)))
                        first[p].append(round(float(secs[win[i]]), 1))
                        crowd[p].append(int(hit.any(axis=0).sum()))
            for s in slices:
                i = int(np.searchsorted(ff.ticks, t0 + s * rate))
                if i >= len(ff.ticks) or ff.ticks[i] > r.end_tick:
                    continue
                for j in cols:
                    if ff.fields["flags"][i, j] & FLAG_ALIVE:
                        slices[s].append([round(float(ff.fields["x"][i, j])), round(float(ff.fields["y"][i, j])),
                                          round(float(ff.fields["z"][i, j]))])
    n = len(analysed)
    zones = []
    for p, ts in first.items():
        arr = np.array(ts)
        hist = np.bincount(np.minimum((arr // BIN_S).astype(int), MAX_S // BIN_S), minlength=MAX_S // BIN_S + 1)
        zones.append({"place": p, "pos": [round(v) for v in centers[p]], "rounds": len(ts), "pct": round(100 * len(ts) / max(1, n), 1),
                      "median_s": round(float(np.median(arr)), 1), "fastest_s": round(float(arr.min()), 1),
                      "p25_s": round(float(np.percentile(arr, 25)), 1), "p75_s": round(float(np.percentile(arr, 75)), 1),
                      "players": round(float(np.mean(crowd[p])), 1), "hist": hist.tolist()})
    zones.sort(key=lambda z: (z["median_s"], -z["pct"]))
    return {"map": map_name, "team_id": team_id, "side": side, "rounds": n, "max_s": MAX_S, "slice_s": SLICE_S,
            "bin_s": BIN_S, "zones": zones, "slices": {str(k): v for k, v in slices.items()}, "list": analysed}
