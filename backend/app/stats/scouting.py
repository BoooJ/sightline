# backend/app/stats/scouting.py
"""Scouting d'une équipe sur plusieurs démos (sous-projet 8) : pool de cartes, tendances par camp, sites, joueurs."""
from __future__ import annotations

from datetime import date
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.stats.compute import _accumulate, _new_teams, _out, _P
from app.stats.grenades import search_grenades
from app.storage.labels import match_date
from app.storage.repository import _DISPLAY
from app.storage.models import BombEvent, Match, Round, Team
from app.storage.repository import _match_summary

pct = lambda a, b: round(100 * a / b, 1) if b else 0.0  # noqa: E731


def _team_matches(session: Session, team_id: int, map_name: str | None = None) -> list[Match]:
    q = select(Match).where((Match.team_a_id == team_id) | (Match.team_b_id == team_id)).order_by(Match.id.desc())
    if map_name:
        q = q.where(Match.map_name == map_name)
    return list(session.scalars(q))


def scouting_teams(session: Session) -> list[dict]:
    """Équipes de la bibliothèque avec bilan, forme récente (5 derniers résultats, du plus récent au plus ancien),
    dernière date de match et cartes jouées (matchs, victoires)."""
    counts: dict[int, dict] = defaultdict(lambda: {"matches": 0, "wins": 0, "maps": defaultdict(lambda: [0, 0]), "games": []})
    for m in session.scalars(select(Match)):
        d = match_date(m)
        for tid, mine, theirs in ((m.team_a_id, m.score_a, m.score_b), (m.team_b_id, m.score_b, m.score_a)):
            c = counts[tid]
            c["matches"] += 1
            c["wins"] += mine > theirs
            c["maps"][m.map_name][0] += 1
            c["maps"][m.map_name][1] += mine > theirs
            c["games"].append((d, m.id, "W" if mine > theirs else "L" if mine < theirs else "D"))
    out = []
    for t in session.scalars(select(Team)):
        c = counts.get(t.id)
        if c:
            games = sorted(c["games"], key=lambda g: (g[0] or date.min, g[1]), reverse=True)
            out.append({"id": t.id, "name": t.name, "matches": c["matches"], "wins": c["wins"], "maps": len(c["maps"]),
                        "recent": [g[2] for g in games[:5]], "last_date": games[0][0].isoformat() if games and games[0][0] else None,
                        "map_list": sorted(({"map": k, "display_name": _DISPLAY.get(k, k), "played": v[0], "won": v[1]} for k, v in c["maps"].items()),
                                           key=lambda x: (-x["played"], x["map"]))})
    return sorted(out, key=lambda t: (-t["matches"], t["name"].lower()))


def _side_block(session: Session, matches: list[Match], team_id: int, side: str) -> dict:
    players: dict = defaultdict(_P)
    teams = _new_teams()
    for m in matches:
        _accumulate(session, m, side, players, defaultdict(lambda: defaultdict(int)), teams)
    t = teams[team_id]
    return {"rounds": t["rounds"], "won": t["rounds_won"], "win_pct": pct(t["rounds_won"], t["rounds"]),
            "pistols": t["pistols"], "pistols_won": t["pistols_won"],
            "opening_won": t["opening_won"], "opening_pct": pct(t["opening_won"], t["rounds"]),
            "plants": t["plants"], "post_plant_won": t["post_plant_won"], "retakes": t["retakes"],
            "retakes_won": t["retakes_won"],
            "buy": {k: {"played": v[0], "won": v[1], "win_pct": pct(v[1], v[0])} for k, v in t["buy"].items()}}


def _sites(session: Session, matches: list[Match], team_id: int) -> dict:
    """Sites de pose quand l'équipe est T, au total et par type d'achat."""
    rounds = [r for m in matches for r in m.rounds if r.t_team_id == team_id]
    plants: dict[int, str | None] = {}
    if rounds:
        for b in session.scalars(select(BombEvent).where(BombEvent.round_id.in_([r.id for r in rounds]),
                                                         BombEvent.type == "plant")):
            plants.setdefault(b.round_id, b.site)
    by_buy: dict[str, dict] = defaultdict(lambda: {"rounds": 0, "A": 0, "B": 0, "none": 0})
    total = {"rounds": 0, "A": 0, "B": 0, "none": 0}
    for r in rounds:
        site = plants.get(r.id, "none") or "none"
        for bucket in (total, by_buy[r.t_buy_type]):
            bucket["rounds"] += 1
            bucket[site if site in ("A", "B") else "none"] += 1
    return {"total": total, "by_buy": dict(by_buy)}


def team_report(session: Session, team_id: int) -> dict | None:
    team = session.get(Team, team_id)
    if team is None:
        return None
    matches = _team_matches(session, team_id)
    by_map: dict[str, list[Match]] = defaultdict(list)
    for m in matches:
        by_map[m.map_name].append(m)
    maps = []
    for name, ms in by_map.items():
        won = sum((m.score_a > m.score_b) if m.team_a_id == team_id else (m.score_b > m.score_a) for m in ms)
        rw = sum(m.score_a if m.team_a_id == team_id else m.score_b for m in ms)
        rl = sum(m.score_b if m.team_a_id == team_id else m.score_a for m in ms)
        ct, t = _side_block(session, ms, team_id, "CT"), _side_block(session, ms, team_id, "T")
        maps.append({"map": name, "display_name": _match_summary(ms[0])["map_display_name"], "played": len(ms),
                     "won": won, "lost": len(ms) - won, "win_pct": pct(won, len(ms)), "rounds_won": rw, "rounds_lost": rl,
                     "ct": ct, "t": t, "sites": _sites(session, ms, team_id)})
    maps.sort(key=lambda x: (-x["played"], -x["win_pct"]))
    # joueurs : stats cumulées sous ce maillot
    players: dict = defaultdict(_P)
    for m in matches:
        _accumulate(session, m, None, players, defaultdict(lambda: defaultdict(int)), _new_teams())
    roster: dict[str, dict] = {}
    for m in matches:
        for mp in m.players:
            if mp.team_id == team_id:
                r = roster.setdefault(mp.steamid, {"steamid": mp.steamid, "name": mp.name_in_match, "matches": 0})
                r["matches"] += 1
    out_players = sorted(({**r, **_out(players.get(sid, _P()))} for sid, r in roster.items()), key=lambda p: -p["rating"])
    recent = []
    for m in matches[:10]:
        s = _match_summary(m)
        mine, theirs = (m.score_a, m.score_b) if m.team_a_id == team_id else (m.score_b, m.score_a)
        recent.append({**s, "opponent": m.team_b.name if m.team_a_id == team_id else m.team_a.name,
                       "score": [mine, theirs], "result": "W" if mine > theirs else "L" if mine < theirs else "D"})
    wins = sum(1 for x in recent if x["result"] == "W")
    return {"team": {"id": team.id, "name": team.name}, "matches": len(matches),
            "wins": sum((m.score_a > m.score_b) if m.team_a_id == team_id else (m.score_b > m.score_a) for m in matches),
            "recent_wins": wins, "maps": maps, "players": out_players, "recent": recent}


def team_map_utility(session: Session, team_id: int, map_name: str, top: int = 12) -> dict:
    """Lineups les plus récurrents de l'équipe sur une carte, par camp."""
    res = search_grenades(session, map_name, team=team_id)
    out = {}
    for side in ("T", "CT"):
        lus = [lu for lu in res["lineups"] if lu["side"] == side and lu["type"] in ("smoke", "flash", "molotov", "incendiary", "he")]
        out[side] = [{k: lu[k] for k in ("type", "count", "throw", "land", "players", "setpos", "trajectory")} for lu in lus[:top]]
    return out
