# backend/app/stats/role_profile.py
"""Profils de rôle par joueur, carte et camp (pour « Apprendre un rôle »).

D'après la recherche (docs/superpowers/specs/2026-10-12-roles-cs2.md) : les rôles forment un continuum, seul l'AWPer
se détache nettement ; ils changent selon la carte et le camp. On calcule donc, par joueur × carte × camp, des
indicateurs mesurables, puis un score continu par rôle (rang centile parmi les joueurs de la bibliothèque sur la même
carte et le même camp), sans étiquette unique imposée.

Indicateurs (fenêtres : trade 5 s, flash ≥ 1,1 s comme Leetify) :
- duels d'ouverture tentés / gagnés, morts vengées, kills de trade, kills et dégâts par round, survie ;
- T : premier du groupe à entrer sur le site de pose (entry), second dans les 3 s (second entry), distance au groupe
  (15 s → pose), loin de la bombe au moment de la pose (lurk) ;
- CT : zone à 0:25 (site A, site B ou milieu), changement de zone avant 0:55 (rotation) ;
- utilitaires lancés, ennemis aveuglés, flash assists, dégâts d'utilitaires ; AWP : part des kills, temps en main."""
from __future__ import annotations

import warnings
from collections import defaultdict

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.parsing.model import FLAG_ALIVE
from app.stats.roles import site_centers
from app.storage.frames_codec import decode_fields, unpack
from app.storage.models import BombEvent, Blind, Damage, Grenade, Kill, Match, MatchPlayer, Round, RoundFrames

SITE_R = 900.0
ENTRY_R = 650.0
LURK_R = 1400.0  # loin du lieu de pose au moment de la pose (vivant, ou mort loin avant la pose)
FLASH_MIN_S = 1.1
UTIL_WEAPONS = ("hegrenade", "inferno", "molotov", "incgrenade", "he_grenade", "high explosive grenade")
MIN_ROUNDS = 8

ROLES = {
    "T": ["entry", "second", "lurker", "support", "awper"],
    "CT": ["anchor_a", "anchor_b", "info", "rotator", "support", "awper"],
}


def _site_dist(sites: dict, x, y, z, k: str):
    c = sites[k]
    d = np.hypot(x - c[0], y - c[1])
    return np.hypot(d, 2 * (z - c[2])) if c[2] is not None else d


def role_profiles(session: Session, maps: dict[str, MapMeta], map_name: str, side: str) -> dict:
    sites = site_centers(session, maps, map_name)
    acc: dict[str, dict] = defaultdict(lambda: defaultdict(float))
    info: dict[str, dict] = {}
    rounds_of: dict[str, list] = defaultdict(list)
    for m in session.scalars(select(Match).where(Match.map_name == map_name).order_by(Match.id)):
        rate = m.demo_tickrate or 64
        mps = {mp.steamid: mp for mp in session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id))}
        names = {m.team_a_id: m.team_a.name, m.team_b_id: m.team_b.name}
        rounds = list(session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)))
        rids = [r.id for r in rounds]
        kills = defaultdict(list)
        for k in session.scalars(select(Kill).where(Kill.round_id.in_(rids)).order_by(Kill.tick)):
            kills[k.round_id].append(k)
        nades = defaultdict(int)
        for g in session.scalars(select(Grenade).where(Grenade.round_id.in_(rids), Grenade.type != "decoy")):
            nades[(g.round_id, g.thrower)] += 1
        blinds = defaultdict(lambda: [0, 0.0])
        for b in session.scalars(select(Blind).where(Blind.round_id.in_(rids), Blind.duration >= FLASH_MIN_S)):
            if b.attacker:
                blinds[(b.round_id, b.attacker, b.victim)] = [1, b.duration]
        dmg = defaultdict(float)
        udmg = defaultdict(float)
        for d in session.scalars(select(Damage).where(Damage.round_id.in_(rids))):
            if d.attacker and d.victim_side and d.attacker_side and d.victim_side != d.attacker_side:
                dmg[(d.round_id, d.attacker)] += d.dmg_health_real
                if d.weapon.lower() in UTIL_WEAPONS:
                    udmg[(d.round_id, d.attacker)] += d.dmg_health_real
        plants = {b.round_id: b for b in session.scalars(select(BombEvent).where(BombEvent.round_id.in_(rids), BombEvent.type == "plant"))}
        for r in rounds:
            side_of = {sid: ("CT" if mp.team_id == r.ct_team_id else "T") for sid, mp in mps.items()}
            mine = [sid for sid, s in side_of.items() if s == side]
            if not mine:
                continue
            fr = session.get(RoundFrames, r.id)  # rounds sans positions : comptés, mais pas proposés à l'étude
            ks = kills.get(r.id, [])
            fk = next((k for k in ks if k.attacker and side_of.get(k.attacker) and side_of.get(k.attacker) != side_of.get(k.victim)), None)
            traded = {k.traded_player for k in ks if k.traded_player}
            dead_at = {k.victim: k.tick for k in ks}
            for sid in mine:
                a = acc[sid]
                info.setdefault(sid, {"steamid": sid, "name": mps[sid].name_in_match, "team": names.get(mps[sid].team_id, "")})
                a["rounds"] += 1
                if fk and sid in (fk.attacker, fk.victim):
                    a["open_att"] += 1
                    a["open_win"] += fk.attacker == sid
                my_kills = [k for k in ks if k.attacker == sid and side_of.get(k.victim) != side]
                a["kills"] += len(my_kills)
                a["awp_kills"] += sum(1 for k in my_kills if k.weapon == "awp")
                a["trade_kills"] += sum(1 for k in my_kills if k.is_trade)
                a["flash_assists"] += sum(1 for k in ks if k.assister == sid and k.flash_assist and side_of.get(k.victim) != side)
                if sid in dead_at:
                    a["deaths"] += 1
                    a["traded"] += sid in traded
                a["util"] += nades[(r.id, sid)]
                fl = [v for (rid, att, vic), v in blinds.items() if rid == r.id and att == sid and side_of.get(vic) and side_of.get(vic) != side]
                a["flashed"] += len(fl)
                a["dmg"] += dmg[(r.id, sid)]
                a["util_dmg"] += udmg[(r.id, sid)]
                if r.winner_side:
                    a["decided"] += 1
                    a["won"] += r.winner_side == side
                if fr is not None and len(rounds_of[sid]) < 40:
                    rounds_of[sid].append([m.id, r.number, r.freeze_end_tick, min(r.end_tick, dead_at.get(sid, r.end_tick)), r.winner_side == side])
            if fr is None:
                continue
            ff = decode_fields(fr.blob, ("x", "y", "z", "flags", "weapon"))
            weapons = unpack(fr.blob).get("weapons", []) if "weapon" in ff.fields else []
            awp_idx = [i for i, w in enumerate(weapons) if w == "AWP"]
            col = {sid: j for j, sid in enumerate(ff.players)}
            secs = (ff.ticks - r.freeze_end_tick) / rate
            alive = (ff.fields["flags"] & FLAG_ALIVE) > 0
            x, y, z = (ff.fields[k].astype(np.float64) for k in ("x", "y", "z"))
            w0 = np.where((secs >= 0) & (secs <= 40) & (ff.ticks <= r.end_tick))[0]
            for sid in mine:
                j = col.get(sid)
                if j is None or not len(w0):
                    continue
                al = alive[w0, j]
                if awp_idx and al.any():
                    acc[sid]["awp_time"] += float(np.isin(ff.fields["weapon"][w0, j][al], awp_idx).mean())
                    acc[sid]["awp_rounds_seen"] += 1
            if side == "T":
                cols = [col[s] for s in mine if s in col]
                plant = plants.get(r.id)
                end = plant.tick if plant else r.freeze_end_tick + 60 * rate
                win = np.where((secs >= 15) & (ff.ticks <= min(end, r.end_tick)))[0]
                for sid in mine:
                    j = col.get(sid)
                    if j is None or not len(win):
                        continue
                    others = [c for c in cols if c != j]
                    al = alive[win, j]
                    if not others or not al.any():
                        continue
                    ox = np.where(alive[np.ix_(win, others)], x[np.ix_(win, others)], np.nan)
                    oy = np.where(alive[np.ix_(win, others)], y[np.ix_(win, others)], np.nan)
                    with np.errstate(all="ignore"), warnings.catch_warnings():
                        warnings.simplefilter("ignore", RuntimeWarning)
                        cx, cy = np.nanmean(ox, axis=1), np.nanmean(oy, axis=1)
                    d = np.hypot(x[win, j] - cx, y[win, j] - cy)
                    ok = al & np.isfinite(d)
                    if ok.any():
                        acc[sid]["dist_sum"] += float(d[ok].mean())
                        acc[sid]["dist_n"] += 1
                if plant and plant.x is not None:
                    acc_round = [s for s in mine if s in col]
                    for sid in acc_round:
                        acc[sid]["plant_rounds"] += 1
                    # ordre d'arrivée sur le lieu de pose avant la pose
                    pre = np.where((ff.ticks >= r.freeze_end_tick) & (ff.ticks <= plant.tick))[0]
                    arrivals = []
                    for sid in acc_round:
                        j = col[sid]
                        dd = np.hypot(x[pre, j] - plant.x, y[pre, j] - plant.y)
                        hit = np.where((dd <= ENTRY_R) & alive[pre, j])[0]
                        if len(hit):
                            arrivals.append((ff.ticks[pre[hit[0]]], sid))
                    arrivals.sort()
                    if arrivals:
                        acc[arrivals[0][1]]["entry"] += 1
                        for t_, sid in arrivals[1:2]:
                            if t_ - arrivals[0][0] <= 3 * rate:
                                acc[sid]["second_entry"] += 1
                    k_ = int(np.searchsorted(ff.ticks, plant.tick))
                    k_ = min(k_, len(ff.ticks) - 1)
                    for sid in acc_round:
                        j = col[sid]
                        if np.hypot(x[k_, j] - plant.x, y[k_, j] - plant.y) > LURK_R:
                            acc[sid]["lurk"] += 1
            else:
                k25 = int(np.searchsorted(ff.ticks, r.freeze_end_tick + 25 * rate))
                k55 = int(np.searchsorted(ff.ticks, r.freeze_end_tick + 55 * rate))
                if k25 >= len(ff.ticks) or ff.ticks[k25] > r.end_tick or not sites:
                    continue
                k55 = min(k55, len(ff.ticks) - 1)

                def zone(k: int, j: int) -> str:
                    best = min(sites, key=lambda s: float(_site_dist(sites, x[k, j], y[k, j], z[k, j], s)))
                    return best if float(_site_dist(sites, x[k, j], y[k, j], z[k, j], best)) <= SITE_R else "mid"
                for sid in mine:
                    j = col.get(sid)
                    if j is None or not alive[k25, j]:
                        continue
                    z25 = zone(k25, j)
                    acc[sid][f"zone_{z25}"] += 1
                    acc[sid]["zone_n"] += 1
                    if ff.ticks[k55] <= r.end_tick and alive[k55, j] and zone(k55, j) not in (z25, "mid"):
                        acc[sid]["rotate"] += 1
    players = []
    for sid, a in acc.items():
        n = a["rounds"]
        if not n:
            continue
        k = {
            "kpr": a["kills"] / n, "adr": a["dmg"] / n, "survival": 1 - a["deaths"] / n,
            "win": a["won"] / a["decided"] if a["decided"] else None,
            "open_att": a["open_att"] / n, "open_win": a["open_win"] / a["open_att"] if a["open_att"] else None,
            "traded": a["traded"] / a["deaths"] if a["deaths"] else None, "trade_kpr": a["trade_kills"] / n,
            "util_pr": a["util"] / n, "flashed_pr": a["flashed"] / n, "flash_assists_pr": a["flash_assists"] / n,
            "util_dmg_pr": a["util_dmg"] / n,
            "awp_kill_share": a["awp_kills"] / a["kills"] if a["kills"] else 0.0,
            "awp_time": a["awp_time"] / a["awp_rounds_seen"] if a["awp_rounds_seen"] else 0.0,
        }
        if side == "T":
            pr = a["plant_rounds"]
            k |= {"entry": a["entry"] / pr if pr else None, "second_entry": a["second_entry"] / pr if pr else None,
                  "lurk": a["lurk"] / pr if pr else None, "team_dist": a["dist_sum"] / a["dist_n"] if a["dist_n"] else None}
        else:
            zn = a["zone_n"]
            k |= {"zone_A": a["zone_A"] / zn if zn else None, "zone_B": a["zone_B"] / zn if zn else None,
                  "zone_mid": a["zone_mid"] / zn if zn else None, "rotate": a["rotate"] / zn if zn else None}
        players.append({**info[sid], "rounds": int(n), "kpis": {kk: (round(v, 3) if isinstance(v, float) else v) for kk, v in k.items()},
                        "reliable": n >= MIN_ROUNDS, "round_list": rounds_of[sid]})
    _score(players, side)
    bench = {}
    for role in ROLES[side]:
        group = [p for p in players if p["primary"] == role]
        bench[role] = {"players": len(group), "kpis": {kk: _median([p["kpis"][kk] for p in group]) for kk in (players[0]["kpis"] if players else {})}}
    return {"map": map_name, "side": side, "roles": ROLES[side], "players": sorted(players, key=lambda p: -p["rounds"]), "benchmarks": bench}


def _median(xs):
    v = [x for x in xs if isinstance(x, (int, float))]
    return round(float(np.median(v)), 3) if v else None


def _pct_rank(players: list, key: str, invert: bool = False) -> dict:
    vals = {p["steamid"]: p["kpis"].get(key) for p in players}
    known = sorted(v for v in vals.values() if v is not None)
    out = {}
    for sid, v in vals.items():
        if v is None or len(known) < 2:
            out[sid] = 0.5
            continue
        below = sum(1 for x in known if x < v) + 0.5 * sum(1 for x in known if x == v) - 0.5
        r = below / (len(known) - 1)
        out[sid] = 1 - r if invert else r
    return out


def _score(players: list, side: str) -> None:
    """Score continu par rôle (0–1) puis répartition en % ; le rôle principal est le score le plus fort.
    L'AWPer est d'abord reconnu sur l'arme (temps en main, part des kills), le signal le plus net."""
    R = lambda k, inv=False: _pct_rank(players, k, inv)  # noqa: E731
    open_att, traded, trade, util, flashed, fa = R("open_att"), R("traded"), R("trade_kpr"), R("util_pr"), R("flashed_pr"), R("flash_assists_pr")
    udmg = R("util_dmg_pr")
    if side == "T":
        entry, second, dist, lurk = R("entry"), R("second_entry"), R("team_dist"), R("lurk")
    else:
        rot = R("rotate")
    for p in players:
        s, k = p["steamid"], p["kpis"]
        awp = min(1.0, 1.2 * max(k["awp_time"], k["awp_kill_share"]))
        support = 0.35 * util[s] + 0.25 * flashed[s] + 0.25 * fa[s] + 0.15 * udmg[s]
        if side == "T":
            sc = {"entry": 0.45 * entry[s] + 0.35 * open_att[s] + 0.2 * traded[s],
                  "second": 0.55 * trade[s] + 0.45 * second[s],
                  "lurker": 0.45 * dist[s] + 0.35 * lurk[s] + 0.2 * (1 - traded[s]),
                  "support": support}
        else:
            za, zb, zm = (k.get("zone_A") or 0), (k.get("zone_B") or 0), (k.get("zone_mid") or 0)
            # ancre : présence sur un site à 0:25 (signal fort, ≥ 60 % des rounds = ancre), moins s'il tourne souvent
            sc = {"anchor_a": min(1.0, 1.3 * za) * (1 - 0.5 * rot[s]), "anchor_b": min(1.0, 1.3 * zb) * (1 - 0.5 * rot[s]),
                  "info": 0.5 * zm + 0.5 * open_att[s], "rotator": 0.5 * rot[s] + 0.5 * zm * (1 - open_att[s]),
                  "support": 0.75 * support}
        sc["awper"] = awp if awp >= 0.35 else awp * 0.5
        tot = sum(sc.values()) or 1
        p["scores"] = {r: round(v / tot, 3) for r, v in sc.items()}
        p["primary"] = "awper" if awp >= 0.5 else max((r for r in sc if r != "awper"), key=lambda r: sc[r])
