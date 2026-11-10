# backend/app/api/players.py
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session, lib_filters, lib_key
from app.stats.cache import LibraryCache
from app.stats.career_extra import career_extras
from app.stats.compute import ECONS, OPP_ECONS, career_stats, match_stats
from app.stats.positions import EDGE_ROLE_LABELS, player_positions
from app.stats.profile import player_profile
from app.stats.roles import ROLE_LABELS, detect_roles
from app.storage.labels import LibraryFilters, filtered_match_ids
from app.storage.models import Kill, Match, MatchPlayer, Round
from app.storage.repository import list_matches

router = APIRouter(prefix="/api/players", tags=["players"])
_cache = LibraryCache(64)


def _side(side: str | None) -> str | None:
    side = side.upper() if side else None
    if side not in (None, "CT", "T"):
        raise HTTPException(400, "side doit valoir CT ou T")
    return side


def _econ(econ: str | None) -> str | None:
    if econ not in (None, *ECONS):
        raise HTTPException(400, "econ invalide (buy, eco, vs_eco, pistol)")
    return econ


def _opp_econ(opp_econ: str | None) -> str | None:
    if opp_econ not in (None, *OPP_ECONS):
        raise HTTPException(400, "opp_econ invalide (buy, eco)")
    return opp_econ


def roles_for(request: Request, db: Session, map_name: str | None) -> dict:
    return _cache.get(db, ("roles", map_name), lambda: detect_roles(db, request.app.state.maps, map_name))


def positions_for(request: Request, db: Session, map_name: str | None, ids: set[int] | None) -> dict:
    """Rôles EDGE et postes (par carte, par match) pour la sélection de matchs courante."""
    key = ("positions", map_name, tuple(sorted(ids)) if ids is not None else None)
    return _cache.get(db, key, lambda: player_positions(db, request.app.state.maps, map_name, ids))


def _edge(pos: dict | None) -> dict:
    """Rôle et poste de chaque camp, forme compacte pour les listes."""
    pick = lambda a: {"role": a.get("role"), "poste": a.get("poste"), "map": a.get("map"), "rounds": a.get("rounds", 0)}  # noqa: E731
    return {"t": pick(pos["T"] if pos else {}), "ct": pick(pos["CT"] if pos else {})}


def _career(db: Session, side, map_name, econ, ids: set[int] | None = None, opp_econ: str | None = None) -> list[dict]:
    key = ("career", side, map_name, econ, tuple(sorted(ids)) if ids is not None else None, opp_econ)
    return _cache.get(db, key, lambda: career_stats(db, side, map_name, econ, ids, opp_econ))


def warm(session_factory, maps) -> None:
    """Précalcule les vues les plus lentes (rôles, carrière) pour que la première visite après un import soit immédiate."""
    with session_factory() as db:
        _cache.get(db, ("roles", None), lambda: detect_roles(db, maps, None))
        _career(db, None, None, None)
        _extras(db, None)


def _extras(db: Session, ids: set[int] | None) -> dict:
    from app.api.matches import players_summary_for  # import tardif : matches importe aussi des modules de stats
    key = ("extras", tuple(sorted(ids)) if ids is not None else None)
    return _cache.get(db, key, lambda: career_extras(db, ids, analysis=players_summary_for))


def _ids(db: Session, map_name, lib: LibraryFilters) -> set[int] | None:
    return filtered_match_ids(db, lib, map_name)


@router.get("/roles")
def role_labels():
    """Libellés des rôles : EDGE (lurk, pack, ancre, rotation…) puis styles (AWPer, Entry…)."""
    return {**EDGE_ROLE_LABELS, **ROLE_LABELS}


@router.get("/extras")
def extras(map: str | None = None, lib: LibraryFilters = Depends(lib_filters), db: Session = Depends(get_session)):
    """Impact, morts évitables, raisons de mort et visée par joueur (classements, comparaison, fiche joueur)."""
    ids = _ids(db, map, lib)
    if map and ids is None:
        ids = set(db.scalars(select(Match.id).where(Match.map_name == map)))
    return _extras(db, ids)


@router.get("")
def players(request: Request, side: str | None = None, map: str | None = None, econ: str | None = None,
            role: str | None = None, opp_econ: str | None = None, lib: LibraryFilters = Depends(lib_filters),
            db: Session = Depends(get_session)):
    side, econ, opp_econ = _side(side), _econ(econ), _opp_econ(opp_econ)
    ids = _ids(db, map, lib)
    roles = roles_for(request, db, map)
    pos = positions_for(request, db, map, ids)
    rows = [{**p, "roles": {k: roles.get(p["steamid"], {}).get(k) for k in ("t", "ct")}, "edge_roles": _edge(pos.get(p["steamid"]))}
            for p in _career(db, side, map, econ, ids, opp_econ)]
    if lib.team:  # contexte « ON équipe » : seulement ses joueurs
        own = set(db.scalars(select(MatchPlayer.steamid).where(MatchPlayer.team_id == lib.team)))
        rows = [p for p in rows if p["steamid"] in own]
    if role:
        if role in EDGE_ROLE_LABELS:
            rows = [p for p in rows if role in (p["edge_roles"]["t"]["role"], p["edge_roles"]["ct"]["role"])]
        elif role in ROLE_LABELS:
            rows = [p for p in rows if role in p["roles"].values()]
        else:
            raise HTTPException(400, "Rôle inconnu")
    return rows


@router.get("/{steamid}/profile")
def profile(request: Request, steamid: str, side: str | None = None, map: str | None = None, econ: str | None = None,
            opp_econ: str | None = None, lib: LibraryFilters = Depends(lib_filters), db: Session = Depends(get_session)):
    """Fiche à onglets (Intro, Rôles, Armes, Achats, Cartes, Officiel vs entraînement, progression), mêmes filtres que
    la barre de contexte."""
    side, econ, opp_econ = _side(side), _econ(econ), _opp_econ(opp_econ)
    ids = _ids(db, map, lib)
    key = ("profile", steamid, side, map, econ, opp_econ, lib_key(lib))
    pr = _cache.get(db, key, lambda: player_profile(db, request.app.state.maps, steamid, ids, side, map, econ, opp_econ))
    if pr is None:
        raise HTTPException(404, "Joueur introuvable pour ces filtres")
    return pr


@router.get("/{steamid}/roles-by-match")
def roles_by_match(request: Request, steamid: str, db: Session = Depends(get_session)):
    """Rôle EDGE et poste du joueur sur chacun de ses matchs (colonne « Rôle » de la bibliothèque)."""
    pos = positions_for(request, db, None, None).get(steamid) or {"matches": {}}
    return {str(mid): _edge(v) for mid, v in pos["matches"].items()}


DASH_METRICS = [("rating", "Rating"), ("kpr", "Kills par round"), ("adr", "Dégâts par round"), ("kast", "KAST"),
                ("hs_pct", "Headshots"), ("opening_pct", "Duels d'ouverture gagnés"), ("trade_kills_pr", "Kills de trade par round"),
                ("utility_pr", "Dégâts utilitaires par round"), ("clutch_pct", "Clutchs gagnés")]


def _derived(p: dict) -> dict:
    r = max(1, p["rounds"])
    return {**p, "trade_kills_pr": p["trade_kills"] / r, "utility_pr": p["utility_dmg"] / r,
            "clutch_pct": 100 * p["clutches_won"] / p["clutches_played"] if p["clutches_played"] else 0.0}


@router.get("/{steamid}/dashboard")
def dashboard(request: Request, steamid: str, db: Session = Depends(get_session)):
    """Tableau de bord d'un joueur (comme le Dashboard d'EDGE) : tendance, cartes, armes, points forts et axes de progrès."""
    base = player(request, steamid, lib=LibraryFilters(), db=db)
    hist = list(reversed(base["history"]))  # chronologique
    trend = [{"match_id": h["match"]["id"] if h["match"] else None, "date": h["match"]["date"] if h["match"] else None,
              "map": h["match"]["map_display_name"] if h["match"] else "", "rating": h["rating"], "adr": h["adr"],
              "won": bool(h["match"]) and ((h["match"]["score_a"] > h["match"]["score_b"]) == (h["match"]["team_a"]["id"] == h["team_id"])),
              "opponent": (h["match"]["team_b"]["name"] if h["match"]["team_a"]["id"] == h["team_id"] else h["match"]["team_a"]["name"]) if h["match"] else ""}
             for h in hist]
    maps: dict[str, dict] = {}
    for h in hist:
        if not h["match"]:
            continue
        mm = maps.setdefault(h["match"]["map_name"], {"map": h["match"]["map_name"], "display_name": h["match"]["map_display_name"],
                                                       "matches": 0, "won": 0, "rating_sum": 0.0, "rounds": 0})
        mm["matches"] += 1
        mm["won"] += next(t["won"] for t in trend if t["match_id"] == h["match"]["id"])
        mm["rating_sum"] += h["rating"] * h["rounds"]
        mm["rounds"] += h["rounds"]
    map_rows = sorted(({"map": v["map"], "display_name": v["display_name"], "matches": v["matches"], "won": v["won"],
                        "win_pct": round(100 * v["won"] / v["matches"], 1),
                        "rating": round(v["rating_sum"] / max(1, v["rounds"]), 2)} for v in maps.values()),
                      key=lambda x: (-x["matches"], -x["rating"]))
    weapons: dict[str, dict] = {}
    q = (select(Kill).join(Round, Round.id == Kill.round_id).join(Match, Match.id == Round.match_id)
         .join(MatchPlayer, (MatchPlayer.match_id == Match.id) & (MatchPlayer.steamid == steamid))
         .where(Kill.attacker == steamid, Kill.victim != steamid))
    for k in db.scalars(q):
        if k.attacker_side and k.attacker_side == k.victim_side:
            continue
        w = weapons.setdefault(k.weapon or "?", {"weapon": k.weapon or "?", "kills": 0, "hs": 0})
        w["kills"] += 1
        w["hs"] += int(k.headshot)
    total_k = max(1, sum(w["kills"] for w in weapons.values()))
    weapon_rows = sorted(({**w, "share": round(100 * w["kills"] / total_k, 1),
                           "hs_pct": round(100 * w["hs"] / w["kills"], 1)} for w in weapons.values()), key=lambda w: -w["kills"])
    # points forts / axes de progrès : écart relatif à la moyenne des joueurs de la bibliothèque
    everyone = [_derived(p) for p in _career(db, None, None, None) if p["rounds"] >= 10]
    me = _derived(base)
    comparisons = []
    for key, label in DASH_METRICS:
        vals = [p[key] for p in everyone]
        avg = sum(vals) / len(vals) if vals else 0
        if avg <= 0:
            continue
        comparisons.append({"key": key, "label": label, "value": round(me[key], 2), "average": round(avg, 2),
                            "delta_pct": round(100 * (me[key] - avg) / avg, 1)})
    comparisons.sort(key=lambda c: -c["delta_pct"])
    return {"player": {k: base[k] for k in ("steamid", "name", "team", "matches", "rounds", "rating", "kpr", "adr", "kast",
                                             "hs_pct", "opening_pct", "kills", "deaths", "diff")},
            "roles": base["roles"], "economy": base["economy"], "trend": trend, "maps": map_rows,
            "weapons": weapon_rows[:12], "strengths": [c for c in comparisons if c["delta_pct"] > 0][:3],
            "weaknesses": [c for c in reversed(comparisons) if c["delta_pct"] < 0][:3], "comparisons": comparisons}


@router.get("/{steamid}")
def player(request: Request, steamid: str, side: str | None = None, map: str | None = None, econ: str | None = None,
           opp_econ: str | None = None, lib: LibraryFilters = Depends(lib_filters), db: Session = Depends(get_session)):
    side, econ, opp_econ = _side(side), _econ(econ), _opp_econ(opp_econ)

    def compute():
        ids = _ids(db, map, lib)
        row = next((p for p in _career(db, side, map, econ, ids, opp_econ) if p["steamid"] == steamid), None)
        if row is None:
            raise HTTPException(404, "Joueur introuvable")
        # rating et indicateurs par contexte économique (comme le découpage buy / eco / contre eco d'EDGE)
        economy = {}
        for e in (None, *ECONS):
            line = next((p for p in _career(db, side, map, e, ids, opp_econ) if p["steamid"] == steamid), None)
            if line and line["rounds"]:
                economy[e or "all"] = {k: line[k] for k in ("rounds", "rating", "kpr", "adr", "kast", "opening_pct", "kills", "deaths")}
        r = roles_for(request, db, map).get(steamid, {})
        pos = positions_for(request, db, map, ids).get(steamid)
        mids = db.scalars(select(MatchPlayer.match_id).join(Match, Match.id == MatchPlayer.match_id)
                         .where(MatchPlayer.steamid == steamid, *([Match.map_name == map] if map else []))).all()
        mids = [x for x in mids if ids is None or x in ids]
        summaries = {m["id"]: m for m in list_matches(db)}
        history = []
        for mid in sorted(mids, reverse=True):
            st = match_stats(db, mid, side, econ, opp_econ)
            line = next((p for p in st["players"] if p["steamid"] == steamid), None)
            if line is None or not line["rounds"]:
                continue
            history.append({"match": summaries.get(mid), "team_id": line["team_id"], **{k: line[k] for k in (
                "rounds", "kills", "deaths", "assists", "diff", "adr", "kast", "hs_pct", "rating",
                "opening_kills", "opening_deaths", "clutches_won", "utility_dmg")}})
        return {**row, "history": history, "economy": economy,
                "roles": {"t": r.get("t"), "ct": r.get("ct")}, "role_features": r.get("features", {}),
                "edge_roles": _edge(pos), "positions": pos["maps"] if pos else {}}

    return _cache.get(db, ("player", steamid, side, map, econ, opp_econ, lib_key(lib)), compute)
