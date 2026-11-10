# backend/app/stats/analysis.py
"""Analyse automatique d'un match : probabilité de victoire round par round et impact de chaque action, raisons de
mort (évitables ou non), avantages numériques perdus et audit économique.

Le modèle de probabilité est une régression logistique calée à la main sur des ordres de grandeur publics du jeu pro
(duel d'ouverture ≈ 70 % de victoire, 5v3 ≈ 86 %, bombe posée en 5v5 ≈ 71 %, éco contre achat complet ≈ 11 %) :
il sert à hiérarchiser les moments d'un round, pas à prédire au pourcent près."""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.parsing.model import FLAG_ALIVE
from app.stats.aim import aim_stats
from app.storage.frames_codec import decode_fields, unpack, _from
from app.stats.utility import NADES, is_half_end, leftover_nades, library_sites, round_utility
from app.storage.models import Blind, BombEvent, Damage, Grenade, Kill, Match, MatchPlayer, Purchase, Round, RoundFrames, Shot

ROUND_S = 115.0  # durée d'un round après le freeze (1:55)
SAMPLE_S = 5.0  # points intermédiaires de la courbe (pression du temps)
ISOLATED_U = 900.0  # aucun coéquipier vivant à moins de cette distance
BEHIND_DEG = 110.0  # angle entre la vue de la victime et la direction du tueur (au-delà : « dos »)
VIEW_DEG, FIELD_DEG, SIDE_DEG = 10.0, 45.0, 110.0  # tranches de l'écart de visée : viseur, champ, côté, dos
AIM_ZONES = {"viseur": "Dans le viseur", "champ": "Dans le champ", "cote": "Sur le côté", "dos": "Dans le dos"}
DUEL_WINDOW_S, AIM_BEFORE_S, CHECK_S, CHECK_DEG = 3.0, 0.25, 8.0, 15.0
SHOT_AIM_DEG, FLASH_MIN_S, FLASH_WINDOW_S = 10.0, 0.7, 2.0
FIRE_HELP_U, SMOKE_HELP_U, NUMBERS_U, FIRE_S = 400.0, 350.0, 800.0, 7.0
LOST_CAUSE = 0.06  # sous cette probabilité de victoire, le round est considéré perdu pour le camp
SAVE_GEAR = 3000  # équipement qui méritait d'être sauvé dans un round perdu

REASONS = {
    "untraded": "Non échangé", "isolated": "Isolé", "behind": "Pris à revers", "blind": "Aveuglé",
    "outnumbered": "En infériorité", "utility": "Utilitaires non utilisés", "opening": "Duel d'ouverture perdu",
    "lost_cause": "Round déjà perdu", "saveable": "Aurait dû sauver",
    "side": "Pris de côté", "unchecked": "Angle jamais regardé", "dry": "Duel à sec",
}


HP_W = 0.012  # logit par point de PV moyen d'écart (50 PV de moins en moyenne ≈ −0,6 logit)


def win_prob_t(n_t: int, n_ct: int, planted: bool, secs_left: float, secs_since_plant: float,
               equip_log_ratio: float, hp_t: float = 100.0, hp_ct: float = 100.0) -> float:
    """Probabilité de victoire des T dans un état donné du round. `hp_t` / `hp_ct` : PV moyens des joueurs vivants ;
    les modèles publiés (Xenopoulos et al.) placent les PV restants juste derrière l'équipement, devant le nombre de
    joueurs vivants."""
    if n_ct == 0:
        return 1.0
    if n_t == 0:
        if not planted:
            return 0.0
        # bombe posée, plus aucun T : les CT doivent encore désamorcer, de moins en moins sûr avec le temps
        return min(0.95, 0.06 + max(0.0, secs_since_plant - 28.0) / 12.0 * 0.9)
    logit = -0.1 + 0.75 * (n_t - n_ct) + 0.6 * math.log(n_t / n_ct) + 0.8 * max(-2.5, min(2.5, equip_log_ratio))
    logit += HP_W * (max(1.0, min(100.0, hp_t)) - max(1.0, min(100.0, hp_ct)))
    if planted:
        logit += 1.0 + 0.04 * secs_since_plant
    elif secs_left < 35:
        logit -= (35 - secs_left) / 35 * 2.2
    return 1 / (1 + math.exp(-logit))


def _inventory_at(blob: bytes, cells: list[tuple[int, int]]) -> tuple[list[str], dict[tuple[int, int], list[int]]]:
    w = unpack(blob)
    m = w["m"]
    off, items = _from(w["inv_offsets"]), _from(w["inv_items"])
    return w["weapons"], {(i, j): items[off[i * m + j]:off[i * m + j + 1]].tolist() for i, j in cells}


def _round_utility(r: Round, last_number: int, rk: list, ff, col: dict, side_of: dict, plant_tick: int | None, fr, tr: int, sites: dict,
                   bought_flash: dict, thrown_flash: dict, kept_flash: dict) -> dict:
    """Grenades restantes de chaque joueur à sa dernière image vivante (mort ou fin du round), puis `round_utility`."""
    if ff is None:
        kept_flash.clear()
        return {"players": {}, "events": []}
    if r.number in (1, 13):
        kept_flash.clear()
    ticks, flags, X, Y = ff.ticks, ff.fields["flags"], ff.fields["x"], ff.fields["y"]
    killed = {}
    for k in rk:
        killed.setdefault(k.victim, k)
    end_i = int(np.searchsorted(ticks, r.end_tick, "right")) - 1
    i40 = int(np.searchsorted(ticks, r.freeze_end_tick + 40 * tr))
    lo = int(np.searchsorted(ticks, r.freeze_end_tick + 15 * tr))
    hi = int(np.searchsorted(ticks, min(r.end_tick, r.freeze_end_tick + 45 * tr), "right"))
    cell_of, cells40 = {}, {}
    for sid, j in col.items():
        if sid not in side_of:
            continue
        k = killed.get(sid)
        i = int(np.searchsorted(ticks, k.tick, "left")) - 1 if k else end_i
        if i < 0 or (not k and not flags[i][j] & FLAG_ALIVE):
            continue
        cell_of[sid] = (i, j)
        if i40 < len(ticks) and ticks[i40] <= r.end_tick and flags[i40][j] & FLAG_ALIVE:
            cells40[sid] = (i40, j)
    weapons, inv = _inventory_at(fr.blob, list(cell_of.values()) + list(cells40.values())) if cell_of else ([], {})
    names = lambda cell: [weapons[w] for w in inv.get(cell, [])]  # noqa: E731
    players = {}
    for sid, cell in cell_of.items():
        i, j = cell
        s_ = side_of[sid]
        p = {"side": s_, "alive": sid not in killed, "inv": names(cell),
             "carried_flash": kept_flash.get(sid, 0), "bought_flash": bought_flash.get((r.id, sid), 0),
             "thrown_flash": thrown_flash.get((r.id, sid), 0)}
        if s_ == "T":
            mates = [jj for o, jj in col.items() if o != sid and side_of.get(o) == "T"]
            ds = []
            for q in range(lo, hi):
                if flags[q][j] & FLAG_ALIVE:
                    dd = [math.hypot(X[q][jj] - X[q][j], Y[q][jj] - Y[q][j]) for jj in mates if flags[q][jj] & FLAG_ALIVE]
                    if dd:
                        ds.append(min(dd))
            p.update(mate_d=float(np.mean(ds)) if ds else None, alive_40=sid in cells40,
                     inv_40=names(cells40[sid]) if sid in cells40 else [], tick_40=r.freeze_end_tick + 40 * tr)
        elif sid in killed:
            k = killed[sid]
            cts = [math.hypot(X[i][jj] - X[i][j], Y[i][jj] - Y[i][j]) for o, jj in col.items()
                   if o != sid and side_of.get(o) == "CT" and flags[i][jj] & FLAG_ALIVE]
            p.update(death_tick=k.tick, death_pos=(k.victim_x, k.victim_y, k.victim_z), ct_d=min(cts) if cts else None)
        players[sid] = p
    out = round_utility(r.number, last_number, tr, r.freeze_end_tick, plant_tick, sites, players)
    kept_flash.clear()
    kept_flash.update({sid: leftover_nades(p["inv"], p["carried_flash"], p["bought_flash"], p["thrown_flash"]).count("Flashbang")
                       for sid, p in players.items() if p["alive"]})
    return out


def _angle(yaw_deg: float, dx: float, dy: float) -> float:
    to = math.degrees(math.atan2(dy, dx))
    return abs((to - yaw_deg + 180) % 360 - 180)


def _aim_zone(offset: float) -> str:
    return "viseur" if offset <= VIEW_DEG else "champ" if offset <= FIELD_DEG else "cote" if offset <= SIDE_DEG else "dos"


def _duel_start(k, damages: list, shots: list, tr: int) -> int | None:
    """Début du duel : le plus tôt entre le premier dégât entre les deux joueurs et le premier tir de l'un visant l'autre
    à 10° près, dans les 3 s avant le kill."""
    lo = k.tick - DUEL_WINDOW_S * tr
    found = [d.tick for d in damages if lo <= d.tick < k.tick and {d.attacker, d.victim} == {k.attacker, k.victim}]
    target = {k.attacker: (k.victim_x, k.victim_y), k.victim: (k.attacker_x, k.attacker_y)}
    for s_ in shots:
        tx, ty = target.get(s_.shooter, (None, None))
        if lo <= s_.tick < k.tick and tx is not None and _angle(s_.yaw, tx - s_.x, ty - s_.y) <= SHOT_AIM_DEG:
            found.append(s_.tick)
    return int(min(found)) if found else None


def _duel_aim(ff, jv: int, jk: int, t0: int, tr: int) -> tuple[float, float, bool] | None:
    """(écart de visée de la victime, du tueur, victime a-t-elle regardé le tueur dans les 8 s avant) à t0 − 0,25 s."""
    i = int(np.searchsorted(ff.ticks, t0 - AIM_BEFORE_S * tr, "right")) - 1
    if i < 0:
        return None
    X, Y, YAW = ff.fields["x"], ff.fields["y"], ff.fields["yaw"]

    def off(q: int, a: int, b: int) -> float:
        return _angle(float(YAW[q][a]), float(X[q][b] - X[q][a]), float(Y[q][b] - Y[q][a]))

    first = int(np.searchsorted(ff.ticks, t0 - CHECK_S * tr))
    checked = any(off(q, jv, jk) <= CHECK_DEG for q in range(first, i + 1))
    return off(i, jv, jk), off(i, jk, jv), checked


def _helps(k, t0: int, tr: int, blinds: list, grenades: list, side_of: dict, pos: dict) -> dict[str, list[str]]:
    """Aide de chaque camp dans le duel : flash, molotov, smoke actives sur l'adversaire, supériorité numérique.
    `pos` : positions (x, y) des joueurs vivants à t0."""
    out = {"killer": [], "victim": []}
    for who, me, opp in (("killer", k.attacker, k.victim), ("victim", k.victim, k.attacker)):
        side = side_of.get(me)
        flash = (who == "killer" and getattr(k, "flash_assist", False)) or any(
            b.victim == opp and b.attacker != b.victim and side_of.get(b.attacker) == side and b.duration >= FLASH_MIN_S
            and t0 - FLASH_WINDOW_S * tr <= b.tick <= k.tick for b in blinds)
        if flash:
            out[who].append("flash")
        ox, oy = pos.get(opp, (None, None))
        for kind, types, dist in (("molotov", ("molotov", "incendiary"), FIRE_HELP_U), ("smoke", ("smoke",), SMOKE_HELP_U)):
            if ox is not None and any(
                    g.type in types and side_of.get(g.thrower) == side and g.detonate_tick is not None and g.detonate_x is not None
                    and g.detonate_tick <= t0 <= (g.end_tick if g.end_tick is not None else g.detonate_tick + FIRE_S * tr)
                    and math.hypot(g.detonate_x - ox, g.detonate_y - oy) <= dist for g in grenades):
                out[who].append(kind)
        if me in pos and opp in pos:
            mx, my = (pos[me][0] + pos[opp][0]) / 2, (pos[me][1] + pos[opp][1]) / 2
            near = [side_of.get(s_) for s_, (x, y) in pos.items() if math.hypot(x - mx, y - my) <= NUMBERS_U]
            if near.count(side) > near.count("T" if side == "CT" else "CT"):
                out[who].append("numbers")
    return out


def match_analysis(session: Session, match_id: int) -> dict | None:
    m = session.get(Match, match_id)
    if m is None:
        return None
    tr = m.demo_tickrate or 64
    mps = list(session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == match_id)))
    name = {p.steamid: p.name_in_match for p in mps}
    team_of = {p.steamid: p.team_id for p in mps}
    rounds = list(session.scalars(select(Round).where(Round.match_id == match_id).order_by(Round.number)))
    rids = [r.id for r in rounds]
    by_round = lambda model: _group(session.scalars(select(model).where(model.round_id.in_(rids)).order_by(model.tick)))
    kills, bombs, blinds = by_round(Kill), by_round(BombEvent), by_round(Blind)
    damages, shots = by_round(Damage), by_round(Shot)
    grenades = _group(session.scalars(select(Grenade).where(Grenade.round_id.in_(rids)).order_by(Grenade.throw_tick)))

    credit: dict[str, float] = defaultdict(float)
    swing_plus: dict[str, float] = defaultdict(float)
    swing_minus: dict[str, float] = defaultdict(float)
    played: dict[str, int] = defaultdict(int)
    out_rounds, deaths, lost_adv, moments = [], [], [], []
    adv_stats = {t: {"had": 0, "won": 0, "had2": 0, "won2": 0} for t in (m.team_a_id, m.team_b_id)}
    econ_team = {t: {"force": 0, "force_won": 0, "eco": 0, "eco_won": 0, "lost_cause_gear": 0, "unused_utility": 0,
                         "kept_utility": 0}
                 for t in (m.team_a_id, m.team_b_id)}
    incoherent = []
    # utilitaire gâché : registre des flashs (achetées / lancées) et montants par joueur
    bought_flash, thrown_flash = defaultdict(int), defaultdict(int)
    for pu in session.scalars(select(Purchase).where(Purchase.round_id.in_(rids), Purchase.item == "Flashbang")):
        bought_flash[(pu.round_id, pu.player)] += 1
    for g in session.scalars(select(Grenade).where(Grenade.round_id.in_(rids), Grenade.type == "flash")):
        thrown_flash[(g.round_id, g.thrower)] += 1
    sites = library_sites(session, m.map_name)
    util_players = {p.steamid: {"dead_value": 0, "alive_value": 0, "half_end_value": 0} for p in mps}
    util_events: list[dict] = []
    util_rounds: list[dict] = []
    kept_flash: dict[str, int] = {}  # flashs gardées en vie au round précédent

    for r in rounds:
        side_of = {sid: ("CT" if t == r.ct_team_id else "T") for sid, t in team_of.items()}
        for sid in side_of:
            played[sid] += 1
        alive = {"CT": sum(1 for s in side_of.values() if s == "CT"), "T": sum(1 for s in side_of.values() if s == "T")}
        alive = {k: min(5, v) or 5 for k, v in alive.items()}
        start_alive = dict(alive)
        equip = math.log(max(1, r.t_equip_value) / max(1, r.ct_equip_value))
        team_side = {r.ct_team_id: "CT", r.t_team_id: "T"}
        plant_tick: int | None = None
        # le round est joué à sa fin : morts d'après-round (bombe qui explose sur des T déjà vainqueurs, kills de joueurs
        # qui sauvent, retraits du serveur) ignorées pour la probabilité, les raisons de mort et les moments décisifs
        rk = [k for k in kills.get(r.id, []) if k.tick <= r.end_tick]
        rb = [b for b in bombs.get(r.id, []) if b.tick <= r.end_tick + tr]
        # PV de chaque joueur, mis à jour au fil des dégâts (les ticks demandés sont croissants)
        hp = {sid: 100 for sid in side_of}
        rd = [d for d in damages.get(r.id, []) if d.tick >= r.freeze_end_tick]
        dmg_i = [0]

        def avg_hp(side: str) -> float:
            vals = [h for s_, h in hp.items() if side_of.get(s_) == side and h > 0]
            return sum(vals) / len(vals) if vals else 100.0

        def p_ct(tick: int) -> float:
            while dmg_i[0] < len(rd) and rd[dmg_i[0]].tick <= tick:
                d = rd[dmg_i[0]]
                if d.victim in hp:
                    hp[d.victim] = max(0, hp[d.victim] - (d.dmg_health_real or 0))
                dmg_i[0] += 1
            secs = (tick - r.freeze_end_tick) / tr
            since = (tick - plant_tick) / tr if plant_tick is not None else 0.0
            return 1 - win_prob_t(alive["T"], alive["CT"], plant_tick is not None, ROUND_S - secs, since, equip, avg_hp("T"), avg_hp("CT"))

        evs = [(k.tick, 0, "kill", k) for k in rk] + [(b.tick, 1, b.type, b) for b in rb if b.type in ("plant", "defuse", "explode")]
        evs.sort(key=lambda e: (e[0], e[1]))
        curve = [[r.freeze_end_tick, round(p_ct(r.freeze_end_tick), 3)]]
        events = []
        next_sample = r.freeze_end_tick + SAMPLE_S * tr
        best = {"CT": 0, "T": 0}  # meilleur avantage numérique atteint
        best_at: dict[str, tuple[int, str]] = {}
        decided = False
        for tick, _, kind, obj in evs:
            while not decided and next_sample < min(tick, r.end_tick):
                curve.append([int(next_sample), round(p_ct(int(next_sample)), 3)])
                next_sample += SAMPLE_S * tr
            before = p_ct(tick)
            actor, victim, side = None, None, None
            if kind == "kill":
                vs = obj.victim_side or side_of.get(obj.victim)
                if vs in alive and alive[vs] > 0:
                    alive[vs] -= 1
                actor, victim = obj.attacker, obj.victim
                side = obj.attacker_side if obj.attacker and obj.attacker != obj.victim and obj.attacker_side != vs else (
                    "T" if vs == "CT" else "CT")
            elif kind == "plant":
                plant_tick, actor, side = tick, obj.player, "T"
            elif kind == "defuse":
                actor, side = obj.player, "CT"
            after = 1.0 if kind == "defuse" else 0.0 if kind == "explode" else p_ct(tick)
            sw = (after - before) if side == "CT" else (before - after)  # gain du camp qui agit
            if kind == "kill":
                real_kill = obj.attacker and obj.attacker != obj.victim and obj.attacker_side != (obj.victim_side or side_of.get(obj.victim))
                if real_kill:
                    credit[obj.attacker] += sw
                    swing_plus[obj.attacker] += sw
                credit[obj.victim] -= sw
                swing_minus[obj.victim] += sw
                for s_, o_ in (("CT", "T"), ("T", "CT")):
                    d = alive[s_] - alive[o_]
                    if d > best[s_]:
                        best[s_], best_at[s_] = d, (tick, f"{alive[s_]}v{alive[o_]}")
            elif actor and kind in ("plant", "defuse"):
                credit[actor] += sw
                swing_plus[actor] += sw
            ev = {"tick": tick, "type": kind, "player": actor, "victim": victim, "side": side,
                  "p_before": round(before, 3), "p_after": round(after, 3), "swing": round(sw, 3)}
            if kind == "kill":
                ev.update(weapon=obj.weapon, place=obj.victim_place, pos=[round(obj.victim_x), round(obj.victim_y), round(obj.victim_z)])
            events.append(ev)
            curve.append([tick, round(after, 3)])
            moments.append({**ev, "round": r.number})
            if kind == "kill" and (alive["CT"] == 0 or alive["T"] == 0) and plant_tick is None:
                decided = True
        if r.winner_side in ("CT", "T"):
            curve.append([r.end_tick, 1.0 if r.winner_side == "CT" else 0.0])

        # avantages numériques
        for tid, s_ in team_side.items():
            if best[s_] >= 1:
                won = r.winner_side == s_
                st = adv_stats[tid]
                st["had"] += 1
                st["won"] += won
                if best[s_] >= 2:
                    st["had2"] += 1
                    st["won2"] += won
                if not won and r.winner_side:
                    lost_adv.append({"round": r.number, "team_id": tid, "side": s_, "state": best_at[s_][1],
                                     "advantage": best[s_], "tick": best_at[s_][0], "end_reason": r.end_reason})

        # économie d'équipe
        for tid, s_ in team_side.items():
            bt = r.ct_buy_type if s_ == "CT" else r.t_buy_type
            won = r.winner_side == s_
            if bt in ("semi", "force"):
                econ_team[tid]["force"] += 1
                econ_team[tid]["force_won"] += won
            elif bt == "eco":
                econ_team[tid]["eco"] += 1
                econ_team[tid]["eco_won"] += won

        # morts : contexte au moment du kill, depuis les images du round
        fr = session.get(RoundFrames, r.id)
        ff = decode_fields(fr.blob, ("x", "y", "yaw", "flags", "equip")) if fr is not None else None
        col = {sid: j for j, sid in enumerate(ff.players)} if ff else {}
        alive2 = dict(start_alive)
        p_by_tick = {e["tick"]: e for e in events if e["type"] == "kill"}
        traded = {k.traded_player for k in rk if k.is_trade and k.traded_player}
        for k in rk:
            vs = k.victim_side or side_of.get(k.victim)
            if vs not in alive2:
                continue
            own_before, enemy_before = alive2[vs], alive2["T" if vs == "CT" else "CT"]
            alive2[vs] = max(0, alive2[vs] - 1)
            ev = next((e for e in events if e["type"] == "kill" and e["tick"] == k.tick and e["victim"] == k.victim), p_by_tick.get(k.tick))
            side_p_before = (ev["p_before"] if vs == "CT" else 1 - ev["p_before"]) if ev else 0.5
            cost = ev["swing"] if ev else 0.0
            reasons = []
            if k.is_opening:
                reasons.append("opening")
            if own_before < enemy_before:
                reasons.append("outnumbered")
            if k.victim not in traded and alive2[vs] > 0:
                reasons.append("untraded")
            if any(b.victim == k.victim and b.tick <= k.tick <= b.tick + b.duration * tr for b in blinds.get(r.id, [])):
                reasons.append("blind")
            if side_p_before < LOST_CAUSE:
                reasons.append("lost_cause")
            d = {"round": r.number, "tick": k.tick, "victim": k.victim, "victim_name": name.get(k.victim, k.victim),
                 "team_id": team_of.get(k.victim), "side": vs, "attacker": k.attacker,
                 "attacker_name": name.get(k.attacker or "", ""), "weapon": k.weapon, "place": k.victim_place,
                 "pos": [round(k.victim_x), round(k.victim_y), round(k.victim_z)],
                 "cost": round(cost, 3), "reasons": reasons, "equip": None, "unused_utility": 0,
                 "t0": None, "aim_offset": None, "killer_aim_offset": None, "aim_zone": None, "checked": None,
                 "help": {"killer": [], "victim": []}}
            if ff is not None and k.victim in col:
                i = int(np.searchsorted(ff.ticks, k.tick, "left")) - 1
                j = col[k.victim]
                if i >= 0:
                    xs, ys, fl = ff.fields["x"][i], ff.fields["y"][i], ff.fields["flags"][i]
                    mates = [jj for sid, jj in col.items() if sid != k.victim and side_of.get(sid) == vs and fl[jj] & FLAG_ALIVE]
                    if mates and min(math.hypot(xs[jj] - xs[j], ys[jj] - ys[j]) for jj in mates) > ISOLATED_U:
                        reasons.append("isolated")
                    if k.attacker in col and k.attacker != k.victim and side_of.get(k.attacker) != vs:
                        t0 = _duel_start(k, damages.get(r.id, []), shots.get(r.id, []), tr)
                        aim_ = _duel_aim(ff, j, col[k.attacker], t0 if t0 is not None else k.tick, tr)
                        if aim_ is not None:
                            zone = _aim_zone(aim_[0])
                            ti = int(np.searchsorted(ff.ticks, t0 if t0 is not None else k.tick, "right")) - 1
                            pos = {sid: (float(ff.fields["x"][ti][jj]), float(ff.fields["y"][ti][jj])) for sid, jj in col.items()
                                   if ff.fields["flags"][ti][jj] & FLAG_ALIVE and sid in side_of}
                            help_ = _helps(k, t0 if t0 is not None else k.tick, tr, blinds.get(r.id, []), grenades.get(r.id, []), side_of, pos)
                            d.update(t0=t0, aim_offset=round(aim_[0], 1), killer_aim_offset=round(aim_[1], 1), aim_zone=zone,
                                     checked=aim_[2], help=help_)
                            if zone == "dos":
                                reasons.append("behind")
                            elif zone == "cote":
                                reasons.append("side")
                            if not aim_[2]:
                                reasons.append("unchecked")
                            if not help_["victim"]:
                                reasons.append("dry")
                    d["equip"] = int(ff.fields["equip"][i][j])
                    if "lost_cause" in reasons and d["equip"] >= SAVE_GEAR:
                        reasons.append("saveable")
            deaths.append(d)
        ru = _round_utility(r, rounds[-1].number, rk, ff, col, side_of, plant_tick, fr, tr, sites, bought_flash, thrown_flash, kept_flash)
        for sid, v in ru["players"].items():
            for key, val in v.items():
                util_players[sid][key] += val
            t = econ_team.get(team_of.get(sid))
            if t is not None:
                t["kept_utility"] += v["alive_value"] + v["half_end_value"]
        util_events += ru["events"]
        # joueurs-rounds où des grenades se perdent vraiment (mort, ou fin de mi-temps) : base de la mesure de débrief
        victims = {k.victim for k in rk}
        for sid, v in ru["players"].items():
            if sid in victims or is_half_end(r.number, rounds[-1].number):
                util_rounds.append({"round": r.number, "steamid": sid, "team_id": team_of.get(sid), "value": v["dead_value"] + v["half_end_value"]})
        for d in deaths:
            if d["round"] == r.number and d["victim"] in ru["players"]:
                d["unused_utility"] = ru["players"][d["victim"]]["dead_value"]
                if d["unused_utility"] > 0:
                    d["reasons"].append("utility")
        for d in deaths:
            if d["round"] != r.number:
                continue
            rs = d["reasons"]
            d["avoidable"] = ("isolated" in rs and "untraded" in rs) or "behind" in rs or "saveable" in rs or ("side" in rs and "unchecked" in rs)
            t = econ_team.get(d["team_id"])
            if t is not None:
                t["unused_utility"] += d["unused_utility"]
                if "saveable" in rs:
                    t["lost_cause_gear"] += d["equip"] or 0

        # achats incohérents : un joueur s'écarte nettement de l'achat de son équipe
        if ff is not None:
            buy_tick = r.freeze_end_tick + 18 * tr
            if rk:
                buy_tick = min(buy_tick, rk[0].tick - 1)
            i = int(np.searchsorted(ff.ticks, buy_tick, "right")) - 1
            if i >= 0 and r.number not in (1, 13):
                for sid, j in col.items():
                    s_ = side_of.get(sid)
                    if s_ is None:
                        continue
                    bt = r.ct_buy_type if s_ == "CT" else r.t_buy_type
                    e = int(ff.fields["equip"][i][j])
                    kind = "eco_alone" if bt in ("full", "force") and e < 1500 else "buy_alone" if bt == "eco" and e >= 3700 else None
                    if kind:
                        incoherent.append({"round": r.number, "steamid": sid, "name": name.get(sid, sid), "team_id": team_of.get(sid),
                                           "side": s_, "team_buy": bt, "equip": e, "kind": kind})
        out_rounds.append({"number": r.number, "winner_side": r.winner_side, "freeze_end_tick": r.freeze_end_tick,
                           "end_tick": r.end_tick, "curve": curve, "events": events})

    aim = aim_stats(session, rids)
    players = []
    for p in mps:
        n = max(1, played[p.steamid])
        mine = [d for d in deaths if d["victim"] == p.steamid]
        duels: dict[str, list[int]] = {}
        dry = [0, 0]  # [duels gagnés à sec, duels perdus à sec]
        for d in deaths:
            if d["aim_zone"] is None:
                continue
            if d["victim"] == p.steamid:
                duels.setdefault(d["aim_zone"], [0, 0])[1] += 1
                dry[1] += not d["help"]["victim"]
            elif d["attacker"] == p.steamid:
                duels.setdefault(_aim_zone(d["killer_aim_offset"]), [0, 0])[0] += 1
                dry[0] += not d["help"]["killer"]
        players.append({
            "duels": duels, "dry": dry,
            "steamid": p.steamid, "name": p.name_in_match, "team_id": p.team_id,
            "impact": round(100 * credit[p.steamid] / n, 1), "swing_plus": round(100 * swing_plus[p.steamid], 1),
            "swing_minus": round(100 * swing_minus[p.steamid], 1), "deaths": len(mine),
            "avoidable": sum(d["avoidable"] for d in mine),
            "reasons": {k: sum(k in d["reasons"] for d in mine) for k in REASONS},
            "unused_utility": sum(d["unused_utility"] for d in mine),
            "lost_cause_gear": sum((d["equip"] or 0) for d in mine if "saveable" in d["reasons"]),
            "rounds": played[p.steamid], "aim": aim.get(p.steamid),
        })
    players.sort(key=lambda p: -p["impact"])
    moments.sort(key=lambda e: -abs(e["swing"]))
    return {
        "match_id": m.id, "tickrate": tr, "reasons": REASONS, "aim_zones": AIM_ZONES, "rounds": out_rounds, "players": players,
        "deaths": deaths, "lost_advantages": lost_adv,
        "advantages": {str(k): v for k, v in adv_stats.items()},
        "utility": {"players": util_players, "events": util_events, "rounds": util_rounds},
        "economy": {"teams": {str(k): v for k, v in econ_team.items()}, "incoherent": incoherent},
        "key_moments": [e for e in moments if e["type"] != "explode"][:10],
        "names": name,
    }


def _group(rows) -> dict[int, list]:
    out: dict[int, list] = defaultdict(list)
    for x in rows:
        out[x.round_id].append(x)
    return out
