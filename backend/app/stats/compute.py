# backend/app/stats/compute.py
"""Statistiques d'un match (sous-projet 2), calculées à la demande depuis les événements stockés.

Conventions (proches de HLTV / des outils pro) :
- ADR : dégâts réels (plafonnés aux PV restants) infligés aux adversaires / rounds joués ;
- KAST : % de rounds avec kill, assist, survie ou mort tradée ;
- Rating : formule publique « Rating 1.0 » de HLTV (kills, survie, multi-kills) ;
- Clutch : premier instant du round où le joueur est le dernier vivant de son camp face à ≥ 1 adversaire ;
- Utilitaire : dégâts HE + molotov/incendiaire, adversaires flashés, durée d'aveuglement infligée."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.storage.models import Blind, BombEvent, Damage, Kill, Match, Round

UTILITY_WEAPONS = {"hegrenade", "inferno", "molotov", "incgrenade"}
SIDES = ("CT", "T")
# HLTV ne publie pas sa formule. On utilise l'approximation publique de la Rating 2.0 (régression sur les données HLTV,
# largement reprise) : KAST, kills, morts, impact (kills + assists) et ADR. La Rating 1.0 (kills, survie, multi-kills)
# ignorait le KAST et les dégâts. La Rating 3.0 (août 2025) ajoute un ajustement à l'économie et le « Round Swing » :
# notre équivalent du swing est l'impact (probabilité de victoire) de l'analyse de match.


@dataclass
class _P:
    rounds: int = 0
    kills: int = 0
    deaths: int = 0
    assists: int = 0
    hs: int = 0
    dmg: int = 0
    kast: int = 0
    opening_kills: int = 0
    opening_deaths: int = 0
    trade_kills: int = 0
    traded_deaths: int = 0
    multi: list[int] = field(default_factory=lambda: [0] * 6)  # multi[k] = rounds à k kills (k ≤ 5)
    clutches: list[list[int]] = field(default_factory=lambda: [[0, 0] for _ in range(6)])  # [1vX] = [joués, gagnés]
    utility_dmg: int = 0
    enemies_flashed: int = 0
    blind_time: float = 0.0
    flash_assists: int = 0
    plants: int = 0
    defuses: int = 0


def rating2(kills: int, deaths: int, assists: int, kast_rounds: int, dmg: float, rounds: int) -> float:
    """Rating 2.0 approchée : 0,0073·KAST(%) + 0,3591·KPR − 0,5329·DPR + 0,2372·Impact + 0,0032·ADR + 0,1587,
    avec Impact = 2,13·KPR + 0,42·APR − 0,41."""
    if not rounds:
        return 0.0
    kpr, dpr, apr = kills / rounds, deaths / rounds, assists / rounds
    impact = 2.13 * kpr + 0.42 * apr - 0.41
    return 0.0073 * (100 * kast_rounds / rounds) + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * (dmg / rounds) + 0.1587


def _rating(p: _P) -> float:
    return rating2(p.kills, p.deaths, p.assists, p.kast, p.dmg, p.rounds)


def _out(p: _P) -> dict:
    r = max(1, p.rounds)
    ok, od = p.opening_kills, p.opening_deaths
    played = sum(c[0] for c in p.clutches[1:])
    won = sum(c[1] for c in p.clutches[1:])
    return {
        "rounds": p.rounds, "kills": p.kills, "deaths": p.deaths, "assists": p.assists, "diff": p.kills - p.deaths,
        "adr": round(p.dmg / r, 1), "kast": round(100 * p.kast / r, 1),
        "hs_pct": round(100 * p.hs / p.kills, 1) if p.kills else 0.0, "kpr": round(p.kills / r, 2),
        "dpr": round(p.deaths / r, 2), "rating": round(_rating(p), 2),
        "opening_kills": ok, "opening_deaths": od,
        "opening_pct": round(100 * ok / (ok + od), 1) if ok + od else 0.0,
        "trade_kills": p.trade_kills, "traded_deaths": p.traded_deaths,
        "multi": {f"{k}k": p.multi[k] for k in range(2, 6)},
        "clutches": {f"1v{k}": {"played": p.clutches[k][0], "won": p.clutches[k][1]} for k in range(1, 6)},
        "clutches_played": played, "clutches_won": won,
        "utility_dmg": p.utility_dmg, "enemies_flashed": p.enemies_flashed, "blind_time": round(p.blind_time, 1),
        "flash_assists": p.flash_assists, "plants": p.plants, "defuses": p.defuses,
    }


def _new_teams() -> dict:
    return defaultdict(lambda: {"rounds_won": 0, "rounds": 0, "pistols_won": 0, "pistols": 0, "opening_won": 0,
                                "plants": 0, "post_plant_won": 0, "retakes_won": 0, "retakes": 0,
                                "buy": defaultdict(lambda: [0, 0])})


ECONS = ("buy", "eco", "vs_eco", "pistol")


OPP_ECONS = ("buy", "eco")


def econ_ok(econ: str | None, own: str, opp: str, opp_econ: str | None = None) -> bool:
    """Contexte économique d'un round vu d'un camp : achat (full/force), eco (eco/semi), contre une eco
    (achat face à eco/semi), pistol ; `opp_econ` restreint en plus l'achat adverse (buy = full/force, eco = eco/semi)."""
    if opp_econ == "buy" and opp not in ("full", "force"):
        return False
    if opp_econ == "eco" and opp not in ("eco", "semi"):
        return False
    if econ is None:
        return True
    if econ == "buy":
        return own in ("full", "force")
    if econ == "eco":
        return own in ("eco", "semi")
    if econ == "vs_eco":
        return own in ("full", "force") and opp in ("eco", "semi")
    return own == "pistol"


def _accumulate(session: Session, m: Match, side: str | None, players: dict[str, _P],
                duels: dict[str, dict[str, int]], teams: dict, econ: str | None = None, opp_econ: str | None = None,
                key=None) -> None:
    """Ajoute les rounds du match `m` aux compteurs (joueurs, duels, équipes). `key(sid, round)` regroupe autrement
    que par joueur (par poste, arme, type d'achat…) ; `None` ignore le joueur pour ce round."""
    team_of = {mp.steamid: mp.team_id for mp in m.players}
    rounds = list(session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)))
    round_ids = [r.id for r in rounds]

    def grouped(model, order):
        out = defaultdict(list)
        for e in session.scalars(select(model).where(model.round_id.in_(round_ids)).order_by(order)):
            out[e.round_id].append(e)
        return out

    kills, damages = grouped(Kill, Kill.tick), grouped(Damage, Damage.tick)
    blinds, bombs = grouped(Blind, Blind.tick), grouped(BombEvent, BombEvent.tick)
    pistol_numbers = {1, 13}  # MR12 (CS2)

    for r in rounds:
        side_of = {sid: ("CT" if tid == r.ct_team_id else "T") for sid, tid in team_of.items()}
        buys = {"CT": r.ct_buy_type, "T": r.t_buy_type}
        ok_side = lambda s_: (side is None or s_ == side) and econ_ok(econ, buys[s_], buys["T" if s_ == "CT" else "CT"], opp_econ)
        counted = [sid for sid in team_of if ok_side(side_of[sid])]
        if not counted:
            continue
        winner_team = r.ct_team_id if r.winner_side == "CT" else r.t_team_id if r.winner_side == "T" else None
        enemy = lambda a, b: a in side_of and b in side_of and side_of[a] != side_of[b]
        sink = _P()  # joueurs de l'autre camp quand un filtre de camp est actif : rien n'est compté
        pk = (lambda sid: sid) if key is None else (lambda sid: key(sid, r))
        P = lambda sid: players[pk(sid)] if sid in side_of and ok_side(side_of[sid]) and pk(sid) is not None else sink

        # --- équipes (vue du camp filtré)
        for tid, s_ in ((r.ct_team_id, "CT"), (r.t_team_id, "T")):
            if not ok_side(s_):
                continue
            t = teams[tid]
            t["rounds"] += 1
            won = winner_team == tid
            t["rounds_won"] += won
            if r.number in pistol_numbers:
                t["pistols"] += 1
                t["pistols_won"] += won
            buy = r.ct_buy_type if s_ == "CT" else r.t_buy_type
            t["buy"][buy][0] += 1
            t["buy"][buy][1] += won
        rk = kills.get(r.id, [])
        first = next((k for k in rk if k.attacker and enemy(k.attacker, k.victim)), None)
        if first and ok_side(side_of[first.attacker]):
            teams[team_of[first.attacker]]["opening_won"] += 1
        plant = next((b for b in bombs.get(r.id, []) if b.type == "plant"), None)
        if plant:
            tt, ct = teams[r.t_team_id], teams[r.ct_team_id]
            if ok_side("T"):
                tt["plants"] += 1
                tt["post_plant_won"] += r.winner_side == "T"
            if ok_side("CT"):
                ct["retakes"] += 1
                ct["retakes_won"] += r.winner_side == "CT"

        # --- joueurs
        round_kills: dict[str, int] = defaultdict(int)
        involved: set[str] = set()
        dead: set[str] = set()
        traded: set[str] = set()
        alive = {s_: {sid for sid in team_of if side_of[sid] == s_} for s_ in SIDES}
        clutch: dict[str, int] = {}  # joueur → nb d'adversaires vivants au début du clutch
        for k in rk:
            if k.attacker and enemy(k.attacker, k.victim):
                round_kills[k.attacker] += 1
                P(k.attacker).hs += int(k.headshot)
                if P(k.attacker) is not sink:
                    duels[k.attacker][k.victim] += 1
                involved.add(k.attacker)
                if k.is_trade:
                    P(k.attacker).trade_kills += 1
                    if k.traded_player:
                        traded.add(k.traded_player)
                if k.flash_assist and k.assister:
                    P(k.assister).flash_assists += 1
            if k.assister and k.assister in side_of and enemy(k.assister, k.victim):
                P(k.assister).assists += 1
                involved.add(k.assister)
            if k.victim in side_of:
                P(k.victim).deaths += 1
                dead.add(k.victim)
                alive[side_of[k.victim]].discard(k.victim)
                for s_ in SIDES:
                    other = alive["T" if s_ == "CT" else "CT"]
                    if len(alive[s_]) == 1 and other:
                        last = next(iter(alive[s_]))
                        clutch.setdefault(last, min(5, len(other)))
            if k is first:
                P(k.attacker).opening_kills += 1
                P(k.victim).opening_deaths += 1
        for sid, n in clutch.items():
            if ok_side(side_of[sid]) and pk(sid) is not None:
                players[pk(sid)].clutches[n][0] += 1
                players[pk(sid)].clutches[n][1] += r.winner_side == side_of[sid]
        for d in damages.get(r.id, []):
            if d.attacker and enemy(d.attacker, d.victim):
                P(d.attacker).dmg += d.dmg_health_real
                if d.weapon in UTILITY_WEAPONS:
                    P(d.attacker).utility_dmg += d.dmg_health_real
        for b in blinds.get(r.id, []):
            if b.attacker and enemy(b.attacker, b.victim):
                P(b.attacker).enemies_flashed += 1
                P(b.attacker).blind_time += b.duration
        for b in bombs.get(r.id, []):
            if b.player and b.type == "plant":
                P(b.player).plants += 1
            elif b.player and b.type == "defuse":
                P(b.player).defuses += 1
        for sid in counted:
            if pk(sid) is None:
                continue
            p = players[pk(sid)]
            p.rounds += 1
            p.kills += round_kills[sid]
            p.multi[min(5, round_kills[sid])] += 1
            p.traded_deaths += sid in traded
            p.kast += sid in involved or sid not in dead or sid in traded


def match_stats(session: Session, match_id: int, side: str | None = None, econ: str | None = None,
                opp_econ: str | None = None) -> dict | None:
    """Stats joueurs + équipes + duels. `side` (« CT »/« T ») restreint aux rounds joués de ce côté."""
    m = session.get(Match, match_id)
    if m is None:
        return None
    players: dict[str, _P] = defaultdict(_P)
    duels: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))  # duels[tueur][victime]
    teams = _new_teams()
    _accumulate(session, m, side, players, duels, teams, econ, opp_econ)
    out_players = []
    for mp in m.players:
        p = players.get(mp.steamid, _P())
        out_players.append({"steamid": mp.steamid, "name": mp.name_in_match, "team_id": mp.team_id, **_out(p)})
    out_players.sort(key=lambda x: (x["team_id"], -x["rating"]))
    out_teams = []
    for t in (m.team_a, m.team_b):
        s_ = teams[t.id]
        pct = lambda a, b: round(100 * a / b, 1) if b else 0.0
        out_teams.append({
            "id": t.id, "name": t.name, "rounds": s_["rounds"], "rounds_won": s_["rounds_won"],
            "pistols": s_["pistols"], "pistols_won": s_["pistols_won"],
            "opening_won": s_["opening_won"], "opening_pct": pct(s_["opening_won"], s_["rounds"]),
            "plants": s_["plants"], "post_plant_won": s_["post_plant_won"],
            "post_plant_pct": pct(s_["post_plant_won"], s_["plants"]),
            "retakes": s_["retakes"], "retakes_won": s_["retakes_won"], "retake_pct": pct(s_["retakes_won"], s_["retakes"]),
            "buy": {k: {"played": v[0], "won": v[1]} for k, v in s_["buy"].items()},
        })
    return {"match_id": m.id, "side": side, "econ": econ, "players": out_players, "teams": out_teams,
            "duels": {a: dict(v) for a, v in duels.items()}}


def career_stats(session: Session, side: str | None = None, map_name: str | None = None,
                 econ: str | None = None, match_ids: set[int] | None = None, opp_econ: str | None = None) -> list[dict]:
    """Stats cumulées de chaque joueur sur tous les matchs de la bibliothèque (filtres : camp, carte)."""
    q = select(Match).order_by(Match.id)
    if map_name:
        q = q.where(Match.map_name == map_name)
    players: dict[str, _P] = defaultdict(_P)
    duels: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    matches: dict[str, int] = defaultdict(int)
    names: dict[str, str] = {}
    team: dict[str, str] = {}
    for m in session.scalars(q):
        if match_ids is not None and m.id not in match_ids:
            continue
        _accumulate(session, m, side, players, duels, _new_teams(), econ, opp_econ)
        tnames = {m.team_a_id: m.team_a.name, m.team_b_id: m.team_b.name}
        for mp in m.players:
            matches[mp.steamid] += 1
            names[mp.steamid], team[mp.steamid] = mp.name_in_match, tnames[mp.team_id]  # dernier nom/équipe vus
    out = [{"steamid": sid, "name": names[sid], "team": team[sid], "matches": n, **_out(players.get(sid, _P()))}
           for sid, n in matches.items()]
    out.sort(key=lambda x: -x["rating"])
    return out
