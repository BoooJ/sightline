# backend/app/stats/prep.py
"""Match Prep (comme EDGE) : un rapport est généré pour un adversaire et une carte à partir d'un template composé de
widgets ; chaque widget est une tranche figée des données de scouting (brief de la carte, bilan, playbook)."""
from __future__ import annotations

from typing import Callable

from sqlalchemy.orm import Session

from sqlalchemy import select

from app.maps.registry import MapMeta
from app.stats.scouting import team_report
from app.stats.tactics import detect_playbook
from app.stats.timings import team_timings
from app.storage.models import Match, Round

GUN_BUYS = ("full", "force")  # « round armé »
SPAWN_S = 10.0  # zones atteintes avant 10 s = abords du spawn

WIDGETS: list[tuple[str, str, str]] = [
    ("overview", "Vue d'ensemble", "Bilan, derniers matchs, cartes jouées"),
    ("reads", "Lectures tactiques", "Ce qu'il faut savoir de leur jeu T et CT sur la carte, et comment les jouer"),
    ("pistols", "Pistols et économie", "Pistols T et CT, round après pistol, premier gun round"),
    ("attack", "Leur attaque (T)", "Styles d'attaque, fin des defaults, sites, premier contact et prise du site"),
    ("sites", "Sites visés (T)", "Où ils posent la bombe, par type d'achat"),
    ("zones", "Zones prises en round armé contre armé", "Zones qu'ils prennent le plus (T) et où ils se placent (CT), quand les deux équipes sont armées (full / force)"),
    ("postplant", "Après le plant", "Rounds gagnés après avoir posé, retakes réussis en défense"),
    ("defense", "Leur défense (CT)", "Placements à 20 s, sites tenus"),
    ("utility", "Grenades habituelles", "Lineups récurrents par camp"),
    ("players", "Joueurs", "Postes à 20 s, AWP, entrée, niveau"),
    ("playbook", "Tactiques (playbook)", "Tactiques les plus jouées en attaque"),
    ("notes", "Notes", "Texte libre (consignes, rappels)"),
]
WIDGET_KEYS = {w[0] for w in WIDGETS}
DEFAULT_TEMPLATE = [{"type": k} for k, _, _ in WIDGETS if k != "notes"] + [{"type": "notes", "text": ""}]


def clean_widgets(raw) -> list[dict]:
    out = []
    for w in raw if isinstance(raw, list) else []:
        if not isinstance(w, dict) or w.get("type") not in WIDGET_KEYS:
            raise ValueError("Widget inconnu")
        item = {"type": w["type"]}
        if w["type"] == "notes":
            item["text"] = str(w.get("text", ""))[:4000]
        if w.get("title"):
            item["title"] = str(w["title"])[:120]
        out.append(item)
    return out[:20]


def _slim(x: dict, keys: tuple[str, ...]) -> dict:
    return {k: x.get(k) for k in keys}


def _gun_rounds(session: Session, team_id: int, map_name: str, side: str) -> set[int]:
    """Rounds « armés » (full / force) de l'équipe sur la carte, pour un camp."""
    out: set[int] = set()
    for m in session.scalars(select(Match).where(Match.map_name == map_name, (Match.team_a_id == team_id) | (Match.team_b_id == team_id))):
        for r in session.scalars(select(Round).where(Round.match_id == m.id)):
            mine = "T" if r.t_team_id == team_id else "CT"
            buy, opp = (r.t_buy_type, r.ct_buy_type) if mine == "T" else (r.ct_buy_type, r.t_buy_type)
            if mine == side and buy in GUN_BUYS and opp in GUN_BUYS:  # armé contre armé
                out.add(r.id)
    return out


def _zones(session: Session, maps: dict[str, MapMeta], team_id: int, map_name: str) -> dict:
    """Zones atteintes en round armé : part des rounds où l'équipe passe par chaque zone, moment médian d'arrivée, joueurs."""
    out = {}
    for side in ("T", "CT"):
        ids = _gun_rounds(session, team_id, map_name, side)
        t = team_timings(session, maps, team_id, map_name, side, ids) if ids else {"rounds": 0, "zones": []}
        # on retire les zones du spawn (atteintes dans les 10 premières secondes) : ce sont des passages obligés, pas des prises
        zones = sorted((z for z in t["zones"] if z["median_s"] >= SPAWN_S), key=lambda z: (-z["pct"], z["median_s"]))[:10]
        out[side] = {"rounds": t["rounds"], "zones": [_slim(z, ("place", "rounds", "pct", "median_s", "p25_s", "p75_s", "players")) for z in zones]}
    return out


def build_report(session: Session, maps: dict[str, MapMeta], team_id: int, map_name: str, widgets: list[dict],
                 brief_of: Callable[[str], dict]) -> dict | None:
    """Contenu figé du rapport : pour chaque widget, les données nécessaires à son affichage."""
    rep = team_report(session, team_id)
    if rep is None or map_name not in maps:
        return None
    meta = maps[map_name]
    brief = brief_of(map_name)
    pb = None
    out = []
    for w in widgets:
        t = w["type"]
        data: dict = {}
        if t == "overview":
            data = {"matches": rep["matches"], "wins": rep["wins"],
                    "recent": [{"id": m["id"], "opponent": m["opponent"], "score": m["score"], "result": m["result"], "map": m["map_display_name"], "date": m.get("date")} for m in rep["recent"][:10]],
                    "maps": [{"map": m["map"], "display_name": m["display_name"], "played": m["played"], "won": m["won"],
                              "ct_win": round(m["ct"]["win_pct"]), "t_win": round(m["t"]["win_pct"])} for m in rep["maps"]]}
        elif t == "reads":
            data = {"matches": brief["matches"], "sides": brief["sides"], "takeaways": brief["takeaways"], "counters": brief["counters"]}
        elif t == "pistols":
            data = {"pistols": brief["pistols"], "first_gun": brief["first_gun"]}
        elif t == "attack":
            data = {"side": brief["sides"]["T"], "avg_contact_s": brief["avg_contact_s"], "avg_plant_s": brief["avg_plant_s"], "styles": brief["t_styles"],
                    "engage_by_site": brief.get("engage_by_site")}
        elif t == "sites":
            mp = next((m for m in rep["maps"] if m["map"] == map_name), None)
            data = {"total": mp["sites"]["total"] if mp else {"rounds": 0, "A": 0, "B": 0, "none": 0},
                    "by_buy": mp["sites"]["by_buy"] if mp else {}, "held": {k: brief["sites"][k]["held"] for k in ("A", "B")},
                    "avg_plant_s": brief["avg_plant_s"]}
        elif t == "zones":
            data = _zones(session, maps, team_id, map_name)
        elif t == "postplant":
            mp = next((m for m in rep["maps"] if m["map"] == map_name), None)
            tb, cb = (mp["t"], mp["ct"]) if mp else ({}, {})
            data = {"t": {"plants": tb.get("plants", 0), "post_plant_won": tb.get("post_plant_won", 0), "rounds": tb.get("rounds", 0)},
                    "ct": {"retakes": cb.get("retakes", 0), "retakes_won": cb.get("retakes_won", 0), "rounds": cb.get("rounds", 0)},
                    "retakes_against": {k: brief["sites"][k]["retakes"] for k in ("A", "B")}, "avg_plant_s": brief["avg_plant_s"]}
        elif t == "defense":
            data = {"side": brief["sides"]["CT"], "setups": brief["ct_setups"][:6], "sites": brief["sites"]}
        elif t == "utility":
            data = {"T": brief["utility"]["T"][:8], "CT": brief["utility"]["CT"][:8]}
        elif t == "players":
            ratings = {p["steamid"]: {"rating": p["rating"], "adr": p["adr"], "kills": p["kills"], "deaths": p["deaths"]} for p in rep["players"]}
            data = {"players": brief["players"], "awper": brief["awper"], "entry": brief["entry"], "ratings": ratings}
        elif t == "playbook":
            if pb is None:
                pb = detect_playbook(session, maps, team_id, map_name, "T", None)
            data = {"total": pb["total"], "tempo": pb["tempo"], "sites": pb["sites"],
                    "categories": [{"key": c["key"], "label": c["label"],
                                    "tactics": [_slim(x, ("name", "used", "won", "pct", "win_pct")) for x in c["tactics"] if x["used"]][:6]}
                                   for c in pb["categories"] if any(x["used"] for x in c["tactics"])]}
        elif t == "notes":
            data = {"text": w.get("text", "")}
        out.append({"type": t, "title": w.get("title") or next(lbl for k, lbl, _ in WIDGETS if k == t), "data": data})
    return {"team": rep["team"], "map": map_name, "display_name": meta.display_name, "matches_on_map": brief["matches"], "widgets": out}
