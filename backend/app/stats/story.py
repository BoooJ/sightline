# backend/app/stats/story.py
"""Histoire d'un round : ce qu'a fait un joueur, étape par étape (achat, placement, utilitaires, kills, bombe, rotation,
mort, fin du round), avec la position de chaque étape pour la carte et son trajet. Sert à « Apprendre un rôle » en
suivant un joueur précis d'une démo précise."""
from __future__ import annotations

from collections import Counter

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.parsing.model import FLAG_ALIVE
from app.stats.grenades import _trajectory, setpos
from app.stats.analysis import _inventory_at
from app.stats.learn import AT_S, _centers, _place_of
from app.stats.utility import leftover_nades
from app.storage.frames_codec import decode_fields
from app.storage.models import BombEvent, Grenade, Kill, Match, MatchPlayer, Purchase, Round, RoundFrames

STAY_S = 6     # un lieu compte comme « placement » si le joueur y reste au moins autant de secondes
PATH_STEP_S = 1
BLAST_S = 1.5  # flash et HE restent affichées autant de secondes après l'explosion


def _r(v) -> list[int] | None:
    return None if v is None or v[0] is None else [round(float(c)) for c in v]


def player_story(session: Session, maps: dict[str, MapMeta], match_id: int, steamid: str) -> dict | None:
    m = session.get(Match, match_id)
    if m is None or m.map_name not in maps:
        return None
    mps = {mp.steamid: mp for mp in session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id))}
    me = mps.get(steamid)
    if me is None:
        return None
    meta = maps[m.map_name]
    centers = _centers(session, meta)
    names = {sid: mp.name_in_match for sid, mp in mps.items()}
    mates = {sid for sid, mp in mps.items() if mp.team_id == me.team_id and sid != steamid}
    enemies = {sid for sid, mp in mps.items() if mp.team_id != me.team_id}
    rate = m.demo_tickrate or 64
    place = lambda p: _place_of(meta, centers, *p) if p and p[0] is not None else None  # noqa: E731
    rounds = []
    carried = 0  # flashs gardées en vie au round précédent (le registre des flashs en a besoin)
    for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
        fr = session.get(RoundFrames, r.id)
        if fr is None:
            carried = 0
            continue
        side = "CT" if me.team_id == r.ct_team_id else "T"
        rd = _round(session, r, fr, steamid, side, rate, names, mates, enemies, place, 0 if r.number in (1, 13) else carried)
        rounds.append(rd)
        left = rd["steps"][0].get("unused") or [] if rd and rd["steps"][-1].get("alive") else []
        carried = left.count("Flashbang")
    return {"match_id": m.id, "map": m.map_name, "steamid": steamid, "name": me.name_in_match,
            "team": m.team_a.name if me.team_id == m.team_a_id else m.team_b.name,
            "opponent": m.team_b.name if me.team_id == m.team_a_id else m.team_a.name,
            "rate": rate, "rounds": [x for x in rounds if x is not None]}


PISTOLS = ("glock", "usp", "p2000", "p250", "five-seven", "tec-9", "cz75", "desert eagle", "dual berettas", "r8")
NOT_PRIMARY = ("knife", "grenade", "flashbang", "molotov", "incendiary", "decoy", "c4", "zeus", "taser", "bayonet", *PISTOLS)


def _main_weapon(ff, j: int, t0: int, stop: int) -> str | None:
    """Arme principale du round : l'arme hors pistolet la plus tenue en main (achetée ou gardée du round précédent),
    sinon le pistolet le plus tenu."""
    if "weapon" not in ff.fields or not ff.weapons:
        return None
    sel = (ff.ticks >= t0) & (ff.ticks <= stop) & ((ff.fields["flags"][:, j] & FLAG_ALIVE) > 0)
    held = Counter(ff.weapons[w] for w in ff.fields["weapon"][sel, j].tolist() if 0 <= w < len(ff.weapons) and ff.weapons[w])
    prim = [w for w, _ in held.most_common() if not any(x in w.lower() for x in NOT_PRIMARY)]
    pistols = [w for w, _ in held.most_common() if any(x in w.lower() for x in PISTOLS)]
    return (prim or pistols or [None])[0]


def _round(session: Session, r: Round, fr: RoundFrames, sid: str, side: str, rate: int, names: dict, mates: set[str],
           enemies: set[str], place, carried_flash: int = 0) -> dict | None:
    ff = decode_fields(fr.blob, ("x", "y", "z", "yaw", "flags", "weapon"))
    if sid not in ff.players:
        return None
    j = ff.players.index(sid)
    t0 = r.freeze_end_tick
    s = lambda tick: round((tick - t0) / rate, 1)  # noqa: E731 — secondes depuis la fin du freeze time
    death = session.scalars(select(Kill).where(Kill.round_id == r.id, Kill.victim == sid)).first()
    stop = min(r.end_tick, death.tick if death else r.end_tick)

    # trajet, une position par seconde tant que le joueur est vivant
    path: list[list[float]] = []
    for k in range(0, int((stop - t0) / rate) + 1, PATH_STEP_S):
        i = int(np.searchsorted(ff.ticks, t0 + k * rate))
        if i >= len(ff.ticks) or ff.ticks[i] > stop or not ff.fields["flags"][i, j] & FLAG_ALIVE:
            break
        path.append([k] + [round(float(ff.fields[c][i, j])) for c in ("x", "y", "z")])

    def yaw_at(tick: int) -> float | None:
        """Direction du regard du joueur (degrés, comme le jeu) à cet instant, s'il est vivant."""
        i = int(np.clip(np.searchsorted(ff.ticks, tick), 0, len(ff.ticks) - 1))
        return round(float(ff.fields["yaw"][i, j]), 1) if ff.fields["flags"][i, j] & FLAG_ALIVE else None

    steps: list[dict] = []
    buys = [p.item for p in session.scalars(select(Purchase).where(Purchase.round_id == r.id, Purchase.player == sid)
                                             .order_by(Purchase.tick))]
    # grenades encore en poche à la dernière image vivante (flashs corrigées par le registre achats − lancers)
    i_last = int(np.searchsorted(ff.ticks, death.tick, "left")) - 1 if death else int(np.searchsorted(ff.ticks, r.end_tick, "right")) - 1
    unused: list[str] = []
    if i_last >= 0 and (death is not None or ff.fields["flags"][i_last, j] & FLAG_ALIVE):
        weapons, inv = _inventory_at(fr.blob, [(i_last, j)])
        thrown = session.scalar(select(func.count()).select_from(Grenade).where(
            Grenade.round_id == r.id, Grenade.thrower == sid, Grenade.type == "flash")) or 0
        unused = leftover_nades([weapons[w] for w in inv[(i_last, j)]], carried_flash, buys.count("Flashbang"), thrown)
    steps.append({"kind": "buy", "t": 0, "tick": t0, "items": buys, "weapon": _main_weapon(ff, j, t0, stop),
                  "pos": path[0][1:] if path else None, "place": None, "unused": unused})

    # placements : lieux où le joueur reste au moins STAY_S secondes (le premier = son poste, les suivants = rotations)
    segs: list[list] = []  # [lieu, t début, t fin, position]
    for t, *p in path:
        pl = place(p)
        if segs and segs[-1][0] == pl:
            segs[-1][2] = t
        else:
            segs.append([pl, t, t, p])
    last = None
    for k, (pl, a, b, p) in enumerate(segs):
        if pl is None or pl == last or (b - a < STAY_S and k != len(segs) - 1):
            continue
        steps.append({"kind": "place", "t": a, "tick": t0 + a * rate, "first": last is None, "place": pl, "pos": p})
        last = pl
    poste = next((pl for pl, a, b, _ in segs if a <= AT_S <= b and pl), None) or next(
        (st["place"] for st in steps if st["kind"] == "place"), None)

    for g in session.scalars(select(Grenade).where(Grenade.round_id == r.id, Grenade.thrower == sid).order_by(Grenade.throw_tick)):
        land = _r((g.detonate_x, g.detonate_y, g.detonate_z))
        traj, last = _trajectory(g.trajectory)
        steps.append({"kind": "nade", "t": s(g.throw_tick), "tick": g.throw_tick, "nade": g.type,
                      "pos": _r((g.throw_x, g.throw_y, g.throw_z)), "place": place(_r((g.throw_x, g.throw_y, g.throw_z))),
                      "target": land or _r(last), "target_place": place(land or _r(last)), "trajectory": traj,
                      "yaw": None if g.throw_yaw is None else round(g.throw_yaw, 1),
                      "pitch": None if g.throw_pitch is None else round(g.throw_pitch, 1), "setpos": setpos(g)})
    kills = list(session.scalars(select(Kill).where(Kill.round_id == r.id, Kill.attacker == sid).order_by(Kill.tick)))
    for k in kills:
        pos = _r((k.attacker_x, k.attacker_y, k.attacker_z))
        steps.append({"kind": "kill", "t": s(k.tick), "tick": k.tick, "victim": names.get(k.victim, "?"), "weapon": k.weapon,
                      "headshot": k.headshot, "opening": k.is_opening, "teamkill": k.victim_side == side,
                      "pos": pos, "place": k.attacker_place or place(pos),
                      "target": _r((k.victim_x, k.victim_y, k.victim_z)), "target_place": k.victim_place})
    for b in session.scalars(select(BombEvent).where(BombEvent.round_id == r.id, BombEvent.player == sid,
                                                     BombEvent.type.in_(("plant", "defuse")))):
        pos = _r((b.x, b.y, b.z))
        steps.append({"kind": b.type, "t": s(b.tick), "tick": b.tick, "site": b.site, "pos": pos, "place": place(pos)})
    if death is not None:
        pos = _r((death.victim_x, death.victim_y, death.victim_z))
        steps.append({"kind": "death", "t": s(death.tick), "tick": death.tick,
                      "attacker": names.get(death.attacker) if death.attacker else None, "weapon": death.weapon,
                      "headshot": death.headshot, "pos": pos, "place": death.victim_place or place(pos),
                      "target": _r((death.attacker_x, death.attacker_y, death.attacker_z)), "target_place": death.attacker_place})
    won = r.winner_side == side if r.winner_side else None
    steps.append({"kind": "end", "t": s(r.end_tick), "tick": r.end_tick, "won": won, "alive": death is None,
                  "pos": path[-1][1:] if path and death is None else None, "place": None})
    # coéquipiers et ennemis vivants à l'instant de chaque étape : comment le joueur joue autour d'eux
    mate_idx = [(k, names.get(p, "?")) for k, p in enumerate(ff.players) if p in mates]
    enemy_idx = [(k, names.get(p, "?")) for k, p in enumerate(ff.players) if p in enemies]

    def alive_at(i: int, idx: list[tuple[int, str]]) -> list[dict]:
        return [{"name": n, "pos": [round(float(ff.fields[c][i, k])) for c in ("x", "y", "z")]}
                for k, n in idx if ff.fields["flags"][i, k] & FLAG_ALIVE]
    # utilitaire ennemi actif à l'instant de chaque étape : en vol (trajectoire jusque-là) ou en effet (smoke, feu,
    # flash et HE pendant BLAST_S après l'explosion)
    enemy_nades = []
    for g in session.scalars(select(Grenade).where(Grenade.round_id == r.id, Grenade.thrower.in_(enemies))):
        traj, last = _trajectory(g.trajectory)
        det = g.detonate_tick if g.detonate_tick is not None else g.throw_tick
        land = _r((g.detonate_x, g.detonate_y, g.detonate_z)) or _r(last)
        end = max(g.end_tick or det, det + int(BLAST_S * rate)) if g.type in ("flash", "he") else max(g.end_tick or det, det)
        enemy_nades.append((g, traj, det, end, land))

    def utility_at(tick: int) -> list[dict]:
        out = []
        for g, traj, det, end, land in enemy_nades:
            if not g.throw_tick <= tick <= end:
                continue
            flying = tick < det
            frac = (tick - g.throw_tick) / max(1, det - g.throw_tick)
            out.append({"type": g.type, "thrower": names.get(g.thrower, "?"), "flying": flying, "pos": land,
                        "trajectory": traj[: max(2, int(len(traj) * frac) + 1)] if flying else traj})
        return out
    for st in steps:
        i = min(int(np.searchsorted(ff.ticks, st["tick"])), len(ff.ticks) - 1)
        st["mates"], st["enemies"] = alive_at(i, mate_idx), alive_at(i, enemy_idx)
        st["enemy_utility"] = utility_at(st["tick"])
        st["view_yaw"] = yaw_at(st["tick"]) if st["kind"] != "death" else None
    plant = session.scalars(select(BombEvent).where(BombEvent.round_id == r.id, BombEvent.type == "plant").order_by(BombEvent.tick)).first()
    order = {"buy": 0, "place": 1, "nade": 2, "kill": 3, "plant": 3, "defuse": 3, "death": 4, "end": 5}
    steps.sort(key=lambda st: (st["tick"], order[st["kind"]]))
    return {"number": r.number, "side": side, "won": won, "kills": len(kills), "died": death is not None,
            "buy": r.ct_buy_type if side == "CT" else r.t_buy_type, "poste": poste,
            "start_tick": t0, "end_tick": int(stop), "round_end_tick": r.end_tick, "path": path, "steps": steps,
            "plant_t": s(plant.tick) if plant is not None and plant.tick <= r.end_tick else None}
