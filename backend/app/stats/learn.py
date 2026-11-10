# backend/app/stats/learn.py
"""Apprendre un poste : comment les joueurs de la bibliothèque jouent un endroit de la carte (ex. ancre A en CT sur
Mirage), et comment je le joue, moi.

Un « poste » est le lieu où se trouve un joueur AT_S secondes après le freeze time (lieux du jeu situés par le centre
des morts, ou callouts placés à la main). Pour chaque round joué à ce poste : trajet, utilitaires lancés, kills, dégâts,
mort (où, quand, par quoi, d'où) et moment où il quitte le poste (rotation)."""
from __future__ import annotations

from collections import defaultdict

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.parsing.model import FLAG_ALIVE
from app.stats.grenades import setpos
from app.stats.roles import site_centers
from app.stats.places import CUSTOM_R, place_markers as _centers, place_of as _place_of
from app.storage.frames_codec import decode_fields
from app.storage.models import BombEvent, Callout, Damage, Grenade, Kill, Match, MatchPlayer, Round, RoundFrames

AT_S = 20          # instant de référence du poste (secondes après le freeze time)
PATH_MAX_S = 90    # trajet étudié
PATH_STEP_S = 2
LEAVE_R = 650.0    # au-delà, le joueur a quitté son poste


def _rounds(session: Session, map_name: str):
    for m in session.scalars(select(Match).where(Match.map_name == map_name).order_by(Match.id)):
        mps = {mp.steamid: mp for mp in session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id))}
        names = {m.team_a_id: m.team_a.name, m.team_b_id: m.team_b.name}
        for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
            yield m, r, mps, names


def position_study(session: Session, maps: dict[str, MapMeta], map_name: str, side: str, at_s: int = AT_S,
                   place: str | None = None) -> dict:
    """Sans `place` : liste des postes (lieu, nombre de rounds, joueurs). Avec `place` : chaque round joué à ce poste."""
    meta = maps[map_name]
    centers = _centers(session, meta)
    places = {x for x in place.split(",") if x} if place else None  # un poste peut regrouper plusieurs lieux
    custom = {c.place: c.label for c in session.scalars(select(Callout).where(Callout.map_name == map_name, Callout.x.is_not(None)))}
    postes: dict[str, dict] = {}
    entries = []
    for m, r, mps, names in _rounds(session, map_name):
        fr = session.get(RoundFrames, r.id)
        if fr is None:
            continue
        rate = m.demo_tickrate or 64
        ff = decode_fields(fr.blob, ("x", "y", "z", "yaw", "flags"))
        i = int(np.searchsorted(ff.ticks, r.freeze_end_tick + at_s * rate))
        if i >= len(ff.ticks) or ff.ticks[i] > r.end_tick:
            continue
        for j, sid in enumerate(ff.players):
            mp = mps.get(sid)
            if mp is None:
                continue
            p_side = "CT" if mp.team_id == r.ct_team_id else "T"
            if p_side != side or not ff.fields["flags"][i, j] & FLAG_ALIVE:
                continue
            x, y, z = (float(ff.fields[k][i, j]) for k in ("x", "y", "z"))
            pl = _place_of(meta, centers, x, y, z)
            if pl is None:
                continue
            won = r.winner_side == side if r.winner_side else None
            po = postes.setdefault(pl, {"place": pl, "rounds": 0, "won": 0, "pos": [0.0, 0.0, 0.0], "players": defaultdict(int),
                                         "by_player": defaultdict(int)})
            po["rounds"] += 1
            po["won"] += 1 if won else 0
            po["players"][mp.name_in_match] += 1
            po["by_player"][sid] += 1
            for k, v in enumerate((x, y, z)):
                po["pos"][k] += v
            if places is None or pl not in places:
                continue
            entries.append(_entry(session, m, r, mp, names, ff, j, i, rate, side, won, (x, y, z)))
    out_postes = []
    for po in postes.values():
        n = po["rounds"]
        out_postes.append({"place": po["place"], "label": custom.get(po["place"]), "rounds": n, "win_pct": round(100 * po["won"] / n),
                           "pos": [round(v / n) for v in po["pos"]],
                           "players": [k for k, _ in sorted(po["players"].items(), key=lambda kv: -kv[1])[:5]],
                           "by_player": dict(po["by_player"])})
    out_postes.sort(key=lambda p: -p["rounds"])
    sites = {k: [round(v) for v in c] if c[2] is not None else [round(c[0]), round(c[1]), None] for k, c in site_centers(session, maps, map_name).items()}
    return {"map": map_name, "side": side, "at_s": at_s, "postes": out_postes, "place": place, "entries": entries, "sites": sites}


def _entry(session: Session, m: Match, r: Round, mp: MatchPlayer, names: dict, ff, j: int, i: int, rate: int, side: str,
           won: bool | None, pos: tuple[float, float, float]) -> dict:
    sid = mp.steamid
    t0 = r.freeze_end_tick
    death = session.scalars(select(Kill).where(Kill.round_id == r.id, Kill.victim == sid)).first()
    end = min(r.end_tick, death.tick if death else r.end_tick, t0 + PATH_MAX_S * rate)
    path = []
    for s in range(0, PATH_MAX_S + 1, PATH_STEP_S):
        k = int(np.searchsorted(ff.ticks, t0 + s * rate))
        if k >= len(ff.ticks) or ff.ticks[k] > end or not ff.fields["flags"][k, j] & FLAG_ALIVE:
            break
        path.append([round(float(ff.fields["x"][k, j])), round(float(ff.fields["y"][k, j])), round(float(ff.fields["z"][k, j]))])
    # rotation : premier instant (après le poste) où le joueur vivant s'en éloigne de plus de LEAVE_R
    left_s = None
    win = np.where((ff.ticks >= ff.ticks[i]) & (ff.ticks <= min(r.end_tick, death.tick if death else r.end_tick)))[0]
    if len(win):
        d = np.hypot(ff.fields["x"][win, j].astype(np.float64) - pos[0], ff.fields["y"][win, j].astype(np.float64) - pos[1])
        far = np.where((d > LEAVE_R) & ((ff.fields["flags"][win, j] & FLAG_ALIVE) > 0))[0]
        if len(far):
            left_s = round(float((ff.ticks[win[far[0]]] - t0) / rate), 1)
    kills = list(session.scalars(select(Kill).where(Kill.round_id == r.id, Kill.attacker == sid).order_by(Kill.tick)))
    dmg = sum(d.dmg_health_real for d in session.scalars(select(Damage).where(Damage.round_id == r.id, Damage.attacker == sid))
              if d.victim_side and d.victim_side != side)
    nades = []
    for g in session.scalars(select(Grenade).where(Grenade.round_id == r.id, Grenade.thrower == sid).order_by(Grenade.throw_tick)):
        land = [round(g.detonate_x), round(g.detonate_y), round(g.detonate_z)] if g.detonate_x is not None else None
        nades.append({"type": g.type, "time_s": round((g.throw_tick - t0) / rate, 1), "throw": [round(g.throw_x), round(g.throw_y), round(g.throw_z)],
                      "land": land, "setpos": setpos(g), "tick": g.throw_tick})
    opp = next((n for t, n in names.items() if t != mp.team_id), "")
    plant = session.scalars(select(BombEvent).where(BombEvent.round_id == r.id, BombEvent.type == "plant")).first()
    # premier contact : premiers dégâts donnés ou reçus
    contact = session.scalars(select(Damage.tick).where(Damage.round_id == r.id, (Damage.attacker == sid) | (Damage.victim == sid))
                              .order_by(Damage.tick)).first()
    traded = death is not None and session.scalars(select(Kill.id).where(Kill.round_id == r.id, Kill.traded_player == sid)).first() is not None
    return {
        "match_id": m.id, "round_number": r.number, "steamid": sid, "name": mp.name_in_match, "team": names.get(mp.team_id, ""),
        "opponent": opp, "won": won, "pos": [round(v) for v in pos], "yaw": round(float(ff.fields["yaw"][i, j]), 1) if "yaw" in ff.fields else None,
        "start_tick": int(t0), "end_tick": int(end), "rate": rate, "path": path, "left_s": left_s,
        "kills": len(kills), "first_kill_s": round((kills[0].tick - t0) / rate, 1) if kills else None,
        "opening_kill": any(k.is_opening for k in kills), "damage": int(dmg), "grenades": nades,
        "kills_detail": [{"time_s": round((k.tick - t0) / rate, 1), "tick": k.tick, "weapon": k.weapon, "opening": k.is_opening,
                          "victim_pos": [round(k.victim_x), round(k.victim_y), round(k.victim_z)], "victim_place": k.victim_place,
                          "pos": [round(k.attacker_x), round(k.attacker_y), round(k.attacker_z)] if k.attacker_x is not None else None}
                         for k in kills],
        "bomb_site": plant.site if plant else None, "plant_s": round((plant.tick - t0) / rate, 1) if plant else None,
        "buy": r.ct_buy_type if side == "CT" else r.t_buy_type, "opp_buy": r.t_buy_type if side == "CT" else r.ct_buy_type,
        "played_at": m.played_at.isoformat() if m.played_at else None, "round_end_s": round((r.end_tick - t0) / rate, 1),
        "contact_s": round((contact - t0) / rate, 1) if contact is not None else None,
        "death": None if death is None else {
            "time_s": round((death.tick - t0) / rate, 1), "tick": death.tick, "pos": [round(death.victim_x), round(death.victim_y), round(death.victim_z)],
            "attacker_pos": [round(death.attacker_x), round(death.attacker_y), round(death.attacker_z)] if death.attacker_x is not None else None,
            "attacker_place": death.attacker_place, "weapon": death.weapon, "opening": death.is_opening, "traded": traded,
        },
    }
