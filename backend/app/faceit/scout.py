# backend/app/faceit/scout.py
"""Scouting d'une équipe FACEIT (saison ESEA) à partir de l'API Data : recherche de l'équipe, roster, matchs, cartes.

Matchs de l'équipe : historiques des membres actuels, gardés si une faction porte l'id de l'équipe, ou réunit au moins
MIN_TOGETHER de ses membres hors matchmaking. Un match ESEA est un match dont la compétition contient « ESEA »."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

from app.faceit.client import HOUR, FaceitClient, FaceitError

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
TEAM_URL = re.compile(rf"faceit\.com/(?:[a-z]{{2}}(?:-[a-z]{{2}})?/)?teams/({UUID})", re.IGNORECASE)
PLAYER_URL = re.compile(r"faceit\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?players/([^/?#\s]+)", re.IGNORECASE)
MATCH_ID = re.compile(rf"1-{UUID}", re.IGNORECASE)
MIN_TOGETHER = 3
HISTORY_LIMIT = 100
MAX_MATCHES = 40
WORKERS = 6
FACTIONS = ("faction1", "faction2")


# la ligue ESEA sur FACEIT : « S59 EU Main B - Regular Season », « ESEA S55 … »
ESEA_DIVISION = re.compile(r"\bS\d{2,3}\b.*\b(open|entry|intermediate|main|advanced|premier|challenger|access)\b", re.IGNORECASE)


def is_esea(competition: str | None) -> bool:
    name = competition or ""
    return "esea" in name.lower() or bool(ESEA_DIVISION.search(name))


def room_url(match_id: str) -> str:
    return f"https://www.faceit.com/en/cs2/room/{match_id}"


def _ts(v) -> str | None:
    return datetime.fromtimestamp(int(v), UTC).isoformat() if isinstance(v, (int, float)) and v else None


def _team_card(t: dict, via: str = "team", **extra) -> dict:
    return {"team_id": t.get("team_id") or t.get("faction_id"), "name": t.get("name") or t.get("nickname") or "?",
            "avatar": t.get("avatar") or "", "via": via, **extra}


# ------------------------------------------------------------------------------------------------- recherche
def search(c: FaceitClient, q: str) -> list[dict]:
    """Équipes correspondant à un lien d'équipe, un id d'équipe, un nom d'équipe ou le pseudo (ou lien) d'un joueur."""
    q = q.strip()
    if not q:
        return []
    m = TEAM_URL.search(q) or re.fullmatch(UUID, q, re.IGNORECASE)
    if m:
        team_id = m.group(1) if m.re is TEAM_URL else q.lower()
        return [_team_card(c.get(f"/teams/{team_id}"))]
    pm = PLAYER_URL.search(q)
    nickname = pm.group(1) if pm else q
    out: list[dict] = []
    if not pm:
        try:
            res = c.get("/search/teams", {"nickname": q, "game": "cs2", "offset": 0, "limit": 10})
            out += [_team_card(t) for t in res.get("items", [])]
        except FaceitError as e:
            if e.status != 404:
                raise
    try:
        player = c.get("/players", {"nickname": nickname})
    except FaceitError as e:
        if e.status != 404:
            raise
        player = None
    if player:  # équipes du joueur d'abord (avec leur nombre de matchs), puis les autres résultats par nom
        mine = teams_of_player(c, player)
        known = {t["team_id"] for t in mine}
        out = mine + [t for t in out if t["team_id"] not in known]
    return out


def teams_of_player(c: FaceitClient, player: dict) -> list[dict]:
    """Équipes avec lesquelles un joueur a disputé des matchs de championnat (ESEA d'abord)."""
    pid = player["player_id"]
    hist = c.get(f"/players/{pid}/history", {"game": "cs2", "offset": 0, "limit": HISTORY_LIMIT}).get("items", [])
    seen: dict[str, dict] = {}
    for it in hist:
        if (it.get("competition_type") or "").lower() == "matchmaking":
            continue
        for fk in FACTIONS:
            f = (it.get("teams") or {}).get(fk) or {}
            if not f.get("team_id") or pid not in {p.get("player_id") for p in f.get("players", [])}:
                continue
            card = seen.setdefault(f["team_id"], _team_card(f, via="player", player=player.get("nickname"),
                                                           matches=0, esea_matches=0))
            card["matches"] += 1
            card["esea_matches"] += is_esea(it.get("competition_name"))
    return sorted(seen.values(), key=lambda t: (-t["esea_matches"], -t["matches"]))


# ---------------------------------------------------------------------------------------------- fiche équipe
def _pmap(fn, items):
    with ThreadPoolExecutor(WORKERS) as ex:
        return list(ex.map(fn, items))


def _get_or_none(c: FaceitClient, path: str, **kw) -> dict | None:
    try:
        return c.get(path, **kw)
    except FaceitError as e:
        if e.status == 404:
            return None
        raise


def team_matches(c: FaceitClient, team_id: str, member_ids: set[str], scope: str = "esea") -> list[dict]:
    """Matchs de l'équipe (du plus récent au plus ancien) : élément d'historique + faction de l'équipe."""
    hists = _pmap(lambda pid: _get_or_none(c, f"/players/{pid}/history",
                                            params={"game": "cs2", "offset": 0, "limit": HISTORY_LIMIT}) or {},
                  sorted(member_ids))
    found: dict[str, dict] = {}
    for h in hists:
        for it in h.get("items", []):
            if it.get("match_id") in found or (it.get("status") or "").lower() != "finished":
                continue
            if scope == "esea" and not is_esea(it.get("competition_name")):
                continue
            mm = (it.get("competition_type") or "").lower() == "matchmaking"
            for fk in FACTIONS:
                f = (it.get("teams") or {}).get(fk) or {}
                together = len({p.get("player_id") for p in f.get("players", [])} & member_ids)
                if f.get("team_id") == team_id or (not mm and together >= MIN_TOGETHER) \
                        or (scope == "all" and together >= MIN_TOGETHER):
                    found[it["match_id"]] = {"item": it, "faction": fk}
                    break
    return sorted(found.values(), key=lambda x: -(x["item"].get("started_at") or 0))


def _match_row(c: FaceitClient, team_id: str, member_ids: set[str], hit: dict) -> dict:
    it, fk = hit["item"], hit["faction"]
    mid = it["match_id"]
    detail = _get_or_none(c, f"/matches/{mid}", ttl=None) or {}
    stats = _get_or_none(c, f"/matches/{mid}/stats", ttl=None) or {}
    teams = detail.get("teams") or {}
    us, them = teams.get(fk) or {}, teams.get("faction2" if fk == "faction1" else "faction1") or {}
    roster = us.get("roster") or []
    our_ids = {us.get("faction_id"), team_id}
    maps = []
    for rnd in stats.get("rounds") or []:
        rs = rnd.get("round_stats") or {}
        sides = rnd.get("teams") or []
        mine = next((t for t in sides if t.get("team_id") in our_ids), None)
        if mine is None:  # stats sans id d'équipe reconnu : on reconnaît l'équipe par ses joueurs
            mine = max(sides, key=lambda t: len({p.get("player_id") for p in t.get("players", [])} & member_ids),
                       default=None)
        other = next((t for t in sides if t is not mine), None)
        su = int((mine or {}).get("team_stats", {}).get("Final Score") or 0)
        so = int((other or {}).get("team_stats", {}).get("Final Score") or 0)
        maps.append({"map": rs.get("Map") or "", "score": [su, so], "won": su > so})
    if not maps:
        picks = ((detail.get("voting") or {}).get("map") or {}).get("pick") or []
        maps = [{"map": p, "score": None, "won": None} for p in picks]
    winner = (it.get("results") or detail.get("results") or {}).get("winner")
    return {
        "match_id": mid, "url": room_url(mid), "started_at": _ts(it.get("started_at")),
        "competition": it.get("competition_name") or detail.get("competition_name") or "",
        "esea": is_esea(it.get("competition_name")),
        "opponent": {"name": them.get("name") or ((it.get("teams") or {}).get("faction2" if fk == "faction1" else "faction1") or {}).get("nickname") or "?",
                     "team_id": them.get("faction_id")},
        "won": (winner == fk) if winner else None, "maps": maps,
        "demos": len(detail.get("demo_url") or []),
        "steamids": [p["game_player_id"] for p in roster if p.get("game_player_id")],
        "players": [p.get("player_id") for p in roster],
    }


def _member(c: FaceitClient, m: dict) -> dict:
    p = _get_or_none(c, f"/players/{m['user_id']}", ttl=6 * HOUR) or {}
    cs2 = (p.get("games") or {}).get("cs2") or {}
    return {"player_id": m["user_id"], "nickname": p.get("nickname") or m.get("nickname") or "?",
            "avatar": p.get("avatar") or m.get("avatar") or "", "country": p.get("country") or "",
            "level": cs2.get("skill_level"), "elo": cs2.get("faceit_elo"),
            "steamid": cs2.get("game_player_id") or p.get("steam_id_64") or None}


def team_overview(c: FaceitClient, team_id: str, scope: str = "esea", max_matches: int = MAX_MATCHES,
                  map_names: dict[str, str] | None = None, active_maps: list[str] | None = None) -> dict:
    """Fiche de scouting : équipe, roster, matchs récents, map pool. `map_names` : nom affiché → nom technique."""
    team = c.get(f"/teams/{team_id}")
    members = [m for m in team.get("members", []) if m.get("user_id")]
    member_ids = {m["user_id"] for m in members}
    hits = team_matches(c, team_id, member_ids, scope)[:max_matches]
    rows = [r for r in _pmap(lambda h: _match_row(c, team_id, member_ids, h), hits)
            if r["maps"]]  # sans carte : forfait, « bye »
    roster = _pmap(lambda m: _member(c, m), members)

    played = Counter(pid for r in rows for pid in r["players"])
    for p in roster:
        p["matches"] = played.get(p["player_id"], 0)
    # anciens joueurs encore fréquents dans les matchs récents (remplaçants, départs)
    regulars = [pid for pid, n in played.most_common() if pid not in member_ids and n >= 3]

    pool: dict[str, dict] = defaultdict(lambda: {"played": 0, "won": 0, "rounds_won": 0, "rounds_lost": 0, "last": None})
    for r in rows:
        for mp in r["maps"]:
            if not mp["map"] or mp["won"] is None:  # carte prévue sans résultat (stats absentes chez FACEIT)
                continue
            e = pool[mp["map"]]
            e["played"] += 1
            e["won"] += bool(mp["won"])
            if mp["score"]:
                e["rounds_won"] += mp["score"][0]
                e["rounds_lost"] += mp["score"][1]
            e["last"] = max(filter(None, [e["last"], r["started_at"]]), default=None)
    faceit_stats = _get_or_none(c, f"/teams/{team_id}/stats/cs2") or {}
    lookup = {k.lower(): v for k, v in (map_names or {}).items()}
    overall = {}
    for seg in faceit_stats.get("segments", []):
        if (seg.get("type") or "").lower() != "map":
            continue
        label = seg.get("label") or ""
        name = lookup.get(label.lower()) or ("de_" + label.lower().replace(" ", ""))
        st = seg.get("stats") or {}
        overall[name] = {"matches": int(float(st.get("Matches") or 0)), "win_pct": float(st.get("Win Rate %") or 0)}
    maps = sorted(set(pool) | set(overall) | set(active_maps or []))
    map_pool = [{"map": m, **pool.get(m, {"played": 0, "won": 0, "rounds_won": 0, "rounds_lost": 0, "last": None}),
                 "faceit": overall.get(m),
                 "active": m in (active_maps or []),
                 "likely_ban": m in (active_maps or []) and not pool.get(m, {}).get("played")} for m in maps]
    map_pool.sort(key=lambda e: (-e["played"], -(e["faceit"] or {}).get("matches", 0), e["map"]))

    return {
        "team": {"team_id": team_id, "name": team.get("name") or team.get("nickname") or "?",
                 "avatar": team.get("avatar") or "", "url": f"https://www.faceit.com/en/teams/{team_id}",
                 "leader": team.get("leader")},
        "scope": scope, "roster": roster, "regulars": regulars,
        "matches": [{k: v for k, v in r.items() if k not in ("players",)} for r in rows],
        "record": {"played": len(rows), "won": sum(1 for r in rows if r["won"])},
        "map_pool": map_pool,
    }
