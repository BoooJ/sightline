# backend/app/stats/profile.py
"""Fiche joueur à onglets (comme Player Stats d'EDGE) : stats regroupées par poste, arme, type d'achat, carte et type
de match, rôle #1 / #2, performance récente et progression. Tout repose sur `compute._accumulate` avec une clé de
regroupement, pour que chaque groupe ait exactement les mêmes indicateurs que la carrière (rating, ADR, K/D, KPR…)."""
from __future__ import annotations

from collections import defaultdict
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.stats.compute import _P, _accumulate, _new_teams, _out, match_stats
from app.stats.positions import EDGE_ROLE_LABELS, MIN_ROUNDS, player_positions
from app.stats.weapons import CLASS_LABELS, WEAPON_CLASS, WEAPON_PRICE, round_primary_weapons
from app.storage.labels import match_date, match_kind
from app.storage.models import Kill, Match, MatchPlayer, Round

BUY_CLASS = {"full": "full", "force": "half", "semi": "half", "eco": "eco", "pistol": "pistol"}
BUY_LABELS = {"full": "Achat complet", "half": "Demi-achat", "eco": "Eco", "pistol": "Pistol"}
PROGRESSION_N, PROGRESSION_MAP_N = 20, 5
GroupKey = Callable[[Match, Round, str], object]


def _player_matches(session: Session, steamid: str, match_ids: set[int] | None, map_name: str | None) -> list[Match]:
    q = select(Match).join(MatchPlayer, MatchPlayer.match_id == Match.id).where(MatchPlayer.steamid == steamid).order_by(Match.id)
    if map_name:
        q = q.where(Match.map_name == map_name)
    return [m for m in session.scalars(q) if match_ids is None or m.id in match_ids]


def grouped_stats(session: Session, matches: list[Match], steamid: str, group: GroupKey, side: str | None,
                  econ: str | None, opp_econ: str | None) -> dict:
    """{clé de groupe: stats `_out`} pour un joueur ; les rounds où `group` renvoie None sont ignorés."""
    players: dict = defaultdict(_P)
    duels: dict = defaultdict(lambda: defaultdict(int))
    for m in matches:
        def key(sid: str, r: Round, m=m):
            if sid != steamid:
                return None
            g = group(m, r, sid)
            return None if g is None else g
        _accumulate(session, m, side, players, duels, _new_teams(), econ, opp_econ, key=key)
    return {k: _out(p) for k, p in players.items() if p.rounds}


def _compact(o: dict) -> dict:
    """Les indicateurs utiles aux tableaux, avec l'effectif."""
    return {k: o[k] for k in ("rounds", "rating", "adr", "kpr", "dpr", "kast", "hs_pct", "opening_pct", "kills", "deaths", "assists",
                              "diff", "utility_dmg", "opening_kills", "opening_deaths")}


def player_profile(session: Session, maps: dict[str, MapMeta], steamid: str, match_ids: set[int] | None, side: str | None,
                   map_name: str | None, econ: str | None, opp_econ: str | None) -> dict | None:
    matches = _player_matches(session, steamid, match_ids, map_name)
    if not matches:
        return None
    mids = {m.id for m in matches}
    pos = player_positions(session, maps, map_name, mids).get(steamid, {})
    round_place = pos.get("round_place", {})
    side_of_round: dict[int, str] = {}
    team_of: dict[int, int] = {}
    buys: dict[int, tuple[str, str]] = {}
    won: dict[int, bool] = {}
    kind_of: dict[int, str] = {m.id: match_kind(m) for m in matches}
    weapons: dict[tuple[int, str], str | None] = {}
    for m in matches:
        tid = next((mp.team_id for mp in m.players if mp.steamid == steamid), None)
        team_of[m.id] = tid
        weapons.update(round_primary_weapons(session, m))
        for r in session.scalars(select(Round).where(Round.match_id == m.id)):
            s = "CT" if r.ct_team_id == tid else "T"
            side_of_round[r.id] = s
            own, opp = (r.ct_buy_type, r.t_buy_type) if s == "CT" else (r.t_buy_type, r.ct_buy_type)
            buys[r.id] = (BUY_CLASS.get(own, own), BUY_CLASS.get(opp, opp))
            won[r.id] = r.winner_side == s

    G = lambda fn: grouped_stats(session, matches, steamid, fn, side, econ, opp_econ)  # noqa: E731

    # ---- rôles : stats par (carte, camp, poste)
    by_poste = G(lambda m, r, sid: (m.map_name, side_of_round[r.id], round_place.get(r.id)) if round_place.get(r.id) else None)
    roles_rows = []
    for (mp, s, place), o in by_poste.items():
        agg = pos.get("maps", {}).get(mp, {}).get(s, {})
        roles_rows.append({"map": mp, "side": s, "poste": place, "role": agg.get("role"), **_compact(o)})
    roles_rows.sort(key=lambda x: -x["rounds"])
    top = [x for x in roles_rows if x["rounds"] >= MIN_ROUNDS][:2]

    # ---- armes : par arme et par classe
    wkey = lambda m, r, sid: weapons.get((r.id, sid))  # noqa: E731
    by_weapon = G(wkey)
    by_class = G(lambda m, r, sid: WEAPON_CLASS.get(weapons.get((r.id, sid)) or "", None))
    # rating économique : valeur des armes principales des adversaires tués ÷ valeur de sa propre arme, par arme
    econ_num: dict = defaultdict(float)
    econ_den: dict = defaultdict(float)
    round_wr: dict = defaultdict(lambda: [0, 0])
    for m in matches:
        rids = [r.id for r in session.scalars(select(Round).where(Round.match_id == m.id))]
        for rid in rids:
            w = weapons.get((rid, steamid))
            if not w:
                continue
            econ_den[w] += WEAPON_PRICE.get(w, 0) or 200
            round_wr[w][0] += 1
            round_wr[w][1] += won.get(rid, False)
        for k in session.scalars(select(Kill).where(Kill.round_id.in_(rids), Kill.attacker == steamid)):
            w = weapons.get((k.round_id, steamid))
            vw = weapons.get((k.round_id, k.victim))
            if w and k.victim != steamid:
                econ_num[w] += WEAPON_PRICE.get(vw or "", 0) or 200
    total_rounds = sum(o["rounds"] for o in by_weapon.values()) or 1
    weapon_rows = []
    for w, o in by_weapon.items():
        weapon_rows.append({"weapon": w, "class": WEAPON_CLASS.get(w), "share": round(100 * o["rounds"] / total_rounds),
                            "econ_rating": round(econ_num[w] / econ_den[w], 2) if econ_den[w] else 0.0,
                            "round_win_pct": round(100 * round_wr[w][1] / round_wr[w][0]) if round_wr[w][0] else 0,
                            "opening_attempts_pct": round(100 * (o["opening_kills"] + o["opening_deaths"]) / o["rounds"]), **_compact(o)})
    weapon_rows.sort(key=lambda x: -x["rounds"])
    class_rows = []
    for c, o in by_class.items():
        ws = [x for x in weapon_rows if x["class"] == c]
        num = sum(econ_num[x["weapon"]] for x in ws)
        den = sum(econ_den[x["weapon"]] for x in ws)
        wr = sum(round_wr[x["weapon"]][1] for x in ws), sum(round_wr[x["weapon"]][0] for x in ws)
        class_rows.append({"class": c, "label": CLASS_LABELS.get(c, c), "share": round(100 * o["rounds"] / total_rounds),
                           "econ_rating": round(num / den, 2) if den else 0.0, "round_win_pct": round(100 * wr[0] / wr[1]) if wr[1] else 0,
                           "opening_attempts_pct": round(100 * (o["opening_kills"] + o["opening_deaths"]) / o["rounds"]), **_compact(o)})
    class_rows.sort(key=lambda x: -x["rounds"])

    # ---- types d'achat : nous × adversaire, et ADR sans les frags sur eco
    by_buy = G(lambda m, r, sid: buys[r.id])
    buy_rows = [{"own": k[0], "opp": k[1], "label": f"{BUY_LABELS.get(k[0], k[0])} vs {BUY_LABELS.get(k[1], k[1])}", **_compact(o)}
                for k, o in by_buy.items()]
    buy_rows.sort(key=lambda x: -x["rounds"])
    by_own = G(lambda m, r, sid: buys[r.id][0])
    own_rows = [{"own": k, "label": BUY_LABELS.get(k, k), **_compact(o)} for k, o in by_own.items()]
    not_vs_eco = G(lambda m, r, sid: "x" if buys[r.id][1] not in ("eco",) else None).get("x")
    all_rounds = G(lambda m, r, sid: "x").get("x")
    adr = {"with_eco": all_rounds["adr"] if all_rounds else 0.0, "without_eco": not_vs_eco["adr"] if not_vs_eco else 0.0,
           "rounds_without_eco": not_vs_eco["rounds"] if not_vs_eco else 0}

    # ---- cartes : par (carte, camp) et par carte
    by_map_side = G(lambda m, r, sid: (m.map_name, side_of_round[r.id]))
    by_map = G(lambda m, r, sid: m.map_name)
    played: dict[str, dict] = defaultdict(lambda: {"matches": 0, "won": 0})
    for m in matches:
        tid = team_of[m.id]
        mine, theirs = (m.score_a, m.score_b) if m.team_a_id == tid else (m.score_b, m.score_a)
        played[m.map_name]["matches"] += 1
        played[m.map_name]["won"] += mine > theirs
    map_rows = []
    for mp, o in by_map.items():
        sides = {s: _compact(by_map_side[(mp, s)]) for s in ("CT", "T") if (mp, s) in by_map_side}
        pm = played[mp]
        map_rows.append({"map": mp, "display_name": maps[mp].display_name if mp in maps else mp, "matches": pm["matches"], "won": pm["won"],
                         "win_pct": round(100 * pm["won"] / pm["matches"]) if pm["matches"] else 0,
                         "avg_kda": [round(o["kills"] / pm["matches"], 1), round(o["deaths"] / pm["matches"], 1), round(o["assists"] / pm["matches"], 1)],
                         "udr": round(o["utility_dmg"] / max(1, o["rounds"]), 2), "sides": sides, **_compact(o)})
    map_rows.sort(key=lambda x: (-x["matches"], -x["rounds"]))

    # ---- officiel vs entraînement
    by_kind = G(lambda m, r, sid: kind_of[m.id])
    kinds = {k: {**_compact(o), "matches": sum(1 for m in matches if kind_of[m.id] == k)} for k, o in by_kind.items()}

    # ---- performance récente et progression (par match, chronologique)
    lines = []
    for m in matches:
        st = match_stats(session, m.id, side, econ, opp_econ)
        line = next((p for p in st["players"] if p["steamid"] == steamid), None) if st else None
        if not line or not line["rounds"]:
            continue
        tid = team_of[m.id]
        mine, theirs = (m.score_a, m.score_b) if m.team_a_id == tid else (m.score_b, m.score_a)
        opp = m.team_b.name if m.team_a_id == tid else m.team_a.name
        pm = pos.get("matches", {}).get(m.id, {})
        lines.append({"match_id": m.id, "date": match_date(m).isoformat() if match_date(m) else None, "map": m.map_name,
                      "display_name": maps[m.map_name].display_name if m.map_name in maps else m.map_name, "opponent": opp,
                      "score": [mine, theirs], "won": mine > theirs, "kind": kind_of[m.id],
                      "poste": {s.lower(): (pm.get(s) or {}).get("poste") for s in ("T", "CT")},
                      **{k: line[k] for k in ("rounds", "rating", "adr", "kpr", "dpr", "kast", "kills", "deaths", "assists", "utility_dmg")}})
    lines.sort(key=lambda x: (x["date"] or "", x["match_id"]))
    n = PROGRESSION_MAP_N if map_name else PROGRESSION_N
    recent, previous = lines[-n:], lines[-2 * n:-n]

    def avg(ls: list[dict]) -> dict | None:
        rounds = sum(x["rounds"] for x in ls)
        if not rounds:
            return None
        w = lambda k: round(sum(x[k] * x["rounds"] for x in ls) / rounds, 3)  # noqa: E731
        return {"matches": len(ls), "rounds": rounds, "rating": w("rating"), "adr": w("adr"), "kpr": w("kpr"), "dpr": w("dpr"), "kast": w("kast"),
                "udr": round(sum(x["utility_dmg"] for x in ls) / rounds, 2)}
    progression = {"n": n, "recent": avg(recent), "previous": avg(previous)}

    last = lines[-1] if lines else None
    rounds_won = sum(1 for rid, w in won.items() if w)
    return {
        "intro": {"team": next((m.team_a.name if m.team_a_id == team_of[m.id] else m.team_b.name) for m in reversed(matches)),
                  "last_match": last["date"] if last else None, "round_win_pct": round(100 * rounds_won / max(1, len(won))),
                  "rounds": len(won), "matches": len(matches), "top_roles": [{**x, "role_label": EDGE_ROLE_LABELS.get(x["role"] or "", None)} for x in top]},
        "roles": roles_rows, "weapons": weapon_rows, "weapon_classes": class_rows,
        "buytypes": {"matrix": buy_rows, "own": own_rows, "adr": adr}, "maps": map_rows, "kinds": kinds,
        "recent": lines[-PROGRESSION_N:], "progression": progression,
    }
