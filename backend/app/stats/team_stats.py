# backend/app/stats/team_stats.py
"""Stats d'équipe (comme Team Stats d'EDGE) : par carte et par camp, rounds gagnés, pistols, ouvertures, trades,
4v5 / 5v4, flash assists et dégâts utilitaires par round, poses / après-pose / retakes ; joueurs du roster avec
duels d'ouverture détaillés et clutchs ; référence = même calcul sur les équipes de comparaison."""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.stats.compute import _P, _accumulate, _new_teams, _out
from app.stats.positions import player_positions
from app.storage.labels import LibraryFilters, filtered_match_ids
from app.storage.models import Kill, Match, Round, Team

SIDES = ("CT", "T")


def _pct(a: float, b: float) -> float:
    return round(100 * a / b, 1) if b else 0.0


def _team_matches(session: Session, team_id: int, match_ids: set[int] | None, map_name: str | None) -> list[Match]:
    q = select(Match).where((Match.team_a_id == team_id) | (Match.team_b_id == team_id)).order_by(Match.id)
    if map_name:
        q = q.where(Match.map_name == map_name)
    return [m for m in session.scalars(q) if match_ids is None or m.id in match_ids]


def _new_block() -> dict:
    return {"rounds": 0, "won": 0, "pistols": 0, "pistols_won": 0, "opening_won": 0, "opening_lost": 0,
            "v5_rounds": 0, "v5_won": 0, "v4_rounds": 0, "v4_won": 0, "plants": 0, "post_plant_won": 0, "retakes": 0, "retakes_won": 0,
            "deaths": 0, "traded_deaths": 0, "flash_assists": 0, "utility_dmg": 0}


def _finish(b: dict) -> dict:
    r = b["rounds"]
    return {**b, "win_pct": _pct(b["won"], r), "pistol_pct": _pct(b["pistols_won"], b["pistols"]),
            "opening_pct": _pct(b["opening_won"], b["opening_won"] + b["opening_lost"]),
            "trade_pct": _pct(b["traded_deaths"], b["deaths"]), "v5_pct": _pct(b["v5_won"], b["v5_rounds"]),
            "v4_pct": _pct(b["v4_won"], b["v4_rounds"]), "far": round(b["flash_assists"] / r, 2) if r else 0.0,
            "udr": round(b["utility_dmg"] / r, 2) if r else 0.0, "post_plant_pct": _pct(b["post_plant_won"], b["plants"]),
            "retake_pct": _pct(b["retakes_won"], b["retakes"])}


def _merge(into: dict, b: dict) -> None:
    for k, v in b.items():
        if isinstance(v, (int, float)) and k in into:
            into[k] += v


def _side_ok(side_filter: str | None, s: str) -> bool:
    return side_filter is None or side_filter == s


def _blocks(session: Session, matches: list[Match], team_id: int, side: str | None, econ: str | None, opp_econ: str | None):
    """Compteurs par (carte, camp) + stats joueurs du roster (cumul sur les rounds retenus) + détails d'ouverture."""
    blocks: dict[tuple[str, str], dict] = defaultdict(_new_block)
    roster: dict[str, dict] = {}
    players_all: dict[str, _P] = defaultdict(_P)
    opening: dict[str, dict] = defaultdict(lambda: {"attempts": 0, "kills": 0, "deaths": 0, "traded": 0, "won_after_kill": 0})
    for m in matches:
        ours = {mp.steamid for mp in m.players if mp.team_id == team_id}
        for mp in m.players:
            if mp.team_id == team_id:
                r_ = roster.setdefault(mp.steamid, {"steamid": mp.steamid, "name": mp.name_in_match, "matches": 0})
                r_["matches"] += 1
        for s in SIDES:
            if not _side_ok(side, s):
                continue
            players: dict[str, _P] = defaultdict(_P)
            teams = _new_teams()
            _accumulate(session, m, s, players, defaultdict(lambda: defaultdict(int)), teams, econ, opp_econ)
            t = teams[team_id]
            if not t["rounds"]:
                continue
            b = blocks[(m.map_name, s)]
            b["rounds"] += t["rounds"]
            b["won"] += t["rounds_won"]
            b["pistols"] += t["pistols"]
            b["pistols_won"] += t["pistols_won"]
            b["plants"] += t["plants"]
            b["post_plant_won"] += t["post_plant_won"]
            b["retakes"] += t["retakes"]
            b["retakes_won"] += t["retakes_won"]
            for sid, p in players.items():
                if sid in ours and p.rounds:
                    b["deaths"] += p.deaths
                    b["traded_deaths"] += p.traded_deaths
                    b["flash_assists"] += p.flash_assists
                    b["utility_dmg"] += p.utility_dmg
                    q = players_all[sid]
                    for k in ("rounds", "kills", "deaths", "assists", "hs", "dmg", "kast", "opening_kills", "opening_deaths", "trade_kills",
                              "traded_deaths", "utility_dmg", "enemies_flashed", "blind_time", "flash_assists", "plants", "defuses"):
                        setattr(q, k, getattr(q, k) + getattr(p, k))
                    q.multi = [a + c for a, c in zip(q.multi, p.multi)]
                    q.clutches = [[a[0] + c[0], a[1] + c[1]] for a, c in zip(q.clutches, p.clutches)]
            # 4v5 / 5v4 et ouvertures détaillées : par round, d'après le premier kill
            rounds = {r.id: r for r in session.scalars(select(Round).where(Round.match_id == m.id))}
            our_side_rounds = [r for r in rounds.values() if (r.ct_team_id == team_id) == (s == "CT")]
            rids = [r.id for r in our_side_rounds]
            if not rids:
                continue
            kills = list(session.scalars(select(Kill).where(Kill.round_id.in_(rids)).order_by(Kill.tick)))
            first: dict[int, Kill] = {}
            traded_in_round: dict[int, set] = defaultdict(set)
            for k in kills:
                if k.attacker and k.attacker_side != k.victim_side:
                    first.setdefault(k.round_id, k)
                if k.is_trade and k.traded_player:
                    traded_in_round[k.round_id].add(k.traded_player)
            for r in our_side_rounds:
                k0 = first.get(r.id)
                if not k0:
                    continue
                won = r.winner_side == s
                if k0.attacker in ours:
                    b["opening_won"] += 1
                    b["v5_rounds"] += 1
                    b["v5_won"] += won
                    o = opening[k0.attacker]
                    o["attempts"] += 1
                    o["kills"] += 1
                    o["won_after_kill"] += won
                    if k0.victim in ours:  # impossible (team kill), ignoré
                        pass
                else:
                    b["opening_lost"] += 1
                    b["v4_rounds"] += 1
                    b["v4_won"] += won
                    if k0.victim in ours:
                        o = opening[k0.victim]
                        o["attempts"] += 1
                        o["deaths"] += 1
                        o["traded"] += k0.victim in traded_in_round[r.id]
    return blocks, roster, players_all, opening


def team_stats(session: Session, maps: dict[str, MapMeta], team_id: int, match_ids: set[int] | None, side: str | None,
               map_name: str | None, econ: str | None, opp_econ: str | None) -> dict | None:
    team = session.get(Team, team_id)
    if team is None:
        return None
    matches = _team_matches(session, team_id, match_ids, map_name)
    blocks, roster, players_all, opening = _blocks(session, matches, team_id, side, econ, opp_econ)
    by_map: dict[str, dict] = {}
    overall = _new_block()
    for (mp, s), b in blocks.items():
        entry = by_map.setdefault(mp, {"map": mp, "display_name": maps[mp].display_name if mp in maps else mp, "sides": {}, "block": _new_block()})
        entry["sides"][s] = _finish(b)
        _merge(entry["block"], b)
        _merge(overall, b)
    played: dict[str, dict] = defaultdict(lambda: {"matches": 0, "won": 0})
    for m in matches:
        mine, theirs = (m.score_a, m.score_b) if m.team_a_id == team_id else (m.score_b, m.score_a)
        played[m.map_name]["matches"] += 1
        played[m.map_name]["won"] += mine > theirs
    maps_out = []
    for mp, e in by_map.items():
        maps_out.append({"map": mp, "display_name": e["display_name"], "matches": played[mp]["matches"], "won": played[mp]["won"],
                         "map_win_pct": _pct(played[mp]["won"], played[mp]["matches"]), **_finish(e["block"]), "sides": e["sides"]})
    maps_out.sort(key=lambda x: (-x["matches"], -x["rounds"]))
    pos = player_positions(session, maps, map_name, {m.id for m in matches})
    players = []
    for sid, r_ in roster.items():
        p = players_all.get(sid, _P())
        o = opening[sid]
        ko, do = o["kills"], o["deaths"]
        rounds = p.rounds
        edge = pos.get(sid, {})
        players.append({**r_, **_out(p), "roles": {"t": (edge.get("T") or {}).get("role"), "ct": (edge.get("CT") or {}).get("role")},
                        "postes": {"t": (edge.get("T") or {}).get("poste"), "ct": (edge.get("CT") or {}).get("poste")},
                        "opening": {"attempts": o["attempts"], "attempts_pct": _pct(o["attempts"], rounds), "kills": ko, "deaths": do,
                                    "kill_pct": _pct(ko, ko + do), "death_pct": _pct(do, ko + do), "kd": round(ko / do, 2) if do else float(ko),
                                    "traded_pct": _pct(o["traded"], do), "ktd": round((ko + o["traded"]) / do, 2) if do else float(ko + o["traded"]),
                                    "won_after_kill_pct": _pct(o["won_after_kill"], ko)}})
    players.sort(key=lambda p: -p["rating"])
    total_matches = len(matches)
    won_matches = sum(1 for m in matches if ((m.score_a > m.score_b) if m.team_a_id == team_id else (m.score_b > m.score_a)))
    return {"team": {"id": team.id, "name": team.name}, "matches": total_matches, "won": won_matches,
            "map_win_pct": _pct(won_matches, total_matches), "overall": _finish(overall), "maps": maps_out, "players": players}


def team_baseline(session: Session, maps: dict[str, MapMeta], team_ids: list[int], months: int | None, side: str | None,
                  map_name: str | None, econ: str | None, opp_econ: str | None, kind: str | None = None) -> dict:
    """Référence d'équipe : compteurs cumulés des équipes de comparaison sur leur fenêtre (moyenne pondérée par les
    rounds, puisque ce sont des sommes)."""
    ids = filtered_match_ids(session, LibraryFilters(months=months, kind=kind), map_name)
    total = _new_block()
    n_teams = 0
    for tid in team_ids:
        matches = _team_matches(session, tid, ids, map_name)
        if not matches:
            continue
        blocks, _, _, _ = _blocks(session, matches, tid, side, econ, opp_econ)
        for b in blocks.values():
            _merge(total, b)
        n_teams += 1
    return {"mode": "teams", "kind": "team", "teams": team_ids, "months": months, "n_teams": n_teams, "rounds": total["rounds"], **_finish(total)}
