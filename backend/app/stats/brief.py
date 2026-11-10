# backend/app/stats/brief.py
"""Brief de scouting d'une équipe sur une carte, lisible par un débutant (docs : reports/Rapport scouting CS2 par LLM.md).

Chaque chiffre est un comptage « k sur n » avec un intervalle (Wilson, 90 %) et un niveau de fiabilité : avec 6 démos on
a 2 ou 3 pistols par camp, et l'interface doit le dire. Les phrases « à retenir » et les pistes pour les contrer sont
écrites par des règles simples à partir de ces comptages (le rapport rédigé par l'IA s'appuiera sur les mêmes faits).

Contenu : pistols T et CT (ce qu'ils jouent, le résultat), round suivant le pistol (conversion, force), premier gun round,
façon d'attaquer et de défendre (playbook), qui joue où à 20 s (par joueur et par camp), AWPer, duels d'ouverture,
utilitaires regroupés par lieu d'arrivée."""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.parsing.model import FLAG_ALIVE
from app.stats.learn import _centers, _place_of
from app.stats.playbook import DEFAULT_KIND_LABELS, DEFAULT_KINDS, engage_summary, team_playbook
from app.storage.frames_codec import decode_fields
from app.storage.models import Grenade, Kill, Match, MatchPlayer, Round, RoundFrames

POS_AT_S = 20         # poste d'un joueur : où il est 20 s après la fin du freeze time
Z90 = 1.645
MIN_INDICATIVE = 6    # en dessous : anecdotique (un round de plus peut tout changer)
MIN_SOLID = 15        # à partir de : solide
NADE_TYPES = {"smoke": "Smoke", "flash": "Flash", "molotov": "Molotov", "incendiary": "Molotov", "he": "HE"}
STYLE_FR = {"rush": "Rush", "execute": "Exécution", "split": "Split (deux entrées)", "fake": "Fake puis autre site",
            "default": "Jeu lent (default)", "eco": "Eco"}
SITE_LABEL = {"A": "A", "B": "B", "none": "aucun site"}


def wilson(k: int, n: int, z: float = Z90) -> tuple[float, float]:
    if not n:
        return 0.0, 1.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def stat(k: int, n: int, rounds: list[int] | None = None, judge: bool = True) -> dict:
    """Comptage avec fiabilité. `tone` : « good »/« bad » seulement pour un taux de réussite (`judge`) dont l'intervalle
    exclut 50 % ; une fréquence (« rush 12 fois sur 33 ») n'est ni bonne ni mauvaise."""
    lo, hi = wilson(k, n)
    level = "none" if not n else "anecdotal" if n < MIN_INDICATIVE else "indicative" if n < MIN_SOLID else "solid"
    tone = "neutral" if not judge else "good" if n and lo > 0.5 else "bad" if n and hi < 0.5 else "neutral"
    return {"k": k, "n": n, "pct": round(100 * k / n) if n else None, "lo": round(100 * lo), "hi": round(100 * hi),
            "level": level, "tone": tone, "rounds": rounds or []}


def pretty_place(place: str | None) -> str | None:
    """« BombsiteA » → « Bombsite A », « HutRoof » → « Hut Roof » (noms de lieux du jeu)."""
    if not place:
        return place
    # « TRamp » → « T Ramp », « CTSpawn » → « CT Spawn » ; les noms déjà espacés (callouts) ne changent pas
    return re.sub(r"(?<=[a-z])(?=[A-Z0-9])|(?<=[A-Z])(?=[A-Z][a-z])", " ", place)


def _lc(s: str) -> str:
    return s[:1].lower() + s[1:]


def _side_of_team(r: Round, team_id: int) -> str:
    return "T" if r.t_team_id == team_id else "CT"


ARMED = ("full", "force")  # « round armé » : achat complet ou forcé


def is_armed_vs_armed(buy: str, opp_buy: str) -> bool:
    return buy in ARMED and opp_buy in ARMED


def team_brief(session: Session, maps: dict[str, MapMeta], team_id: int, map_name: str, armed: bool = False) -> dict:
    """`armed` : ne garder que les rounds armés contre armés (full / force des deux côtés) — le jeu « normal »,
    sans les pistols, ecos et anti-ecos."""
    meta = maps[map_name]
    matches = list(session.scalars(select(Match).where(Match.map_name == map_name,
                                                        (Match.team_a_id == team_id) | (Match.team_b_id == team_id))
                                   .order_by(Match.id)))
    pb = team_playbook(session, maps, team_id, map_name)
    t_info = {x["round_id"]: x for x in pb["t"]["list"]}
    ct_info = {x["round_id"]: x for x in pb["ct"]["list"]}
    centers = _centers(session, meta)

    rows: list[dict] = []   # un round vu du côté de l'équipe
    names: dict[str, str] = {}
    pos: dict[tuple[str, str], Counter] = defaultdict(Counter)
    pos_rounds: dict[tuple[str, str], list[int]] = defaultdict(list)
    pos_sum: dict[tuple[str, str, str], list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0, 0])
    for m in matches:
        mine = {mp.steamid for mp in session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id,
                                                                               MatchPlayer.team_id == team_id))}
        for mp in session.scalars(select(MatchPlayer).where(MatchPlayer.match_id == m.id, MatchPlayer.steamid.in_(mine))):
            names[mp.steamid] = mp.name_in_match
        for r in session.scalars(select(Round).where(Round.match_id == m.id).order_by(Round.number)):
            side = _side_of_team(r, team_id)
            buy, opp_buy = (r.t_buy_type, r.ct_buy_type) if side == "T" else (r.ct_buy_type, r.t_buy_type)
            if armed and not is_armed_vs_armed(buy, opp_buy):
                continue
            rows.append({"round_id": r.id, "match_id": m.id, "number": r.number, "side": side,
                         "buy": buy, "opp_buy": opp_buy, "won": r.winner_side == side})
            fr = session.get(RoundFrames, r.id)
            if fr is None:
                continue
            fd = decode_fields(fr.blob)
            i = int(np.clip(np.searchsorted(fd.ticks, r.freeze_end_tick + POS_AT_S * m.demo_tickrate), 0, len(fd.ticks) - 1))
            alive = (fd.fields["flags"][i] & FLAG_ALIVE) > 0
            for j, sid in enumerate(fd.players):
                if sid in mine and alive[j]:
                    x, y, z = float(fd.fields["x"][i, j]), float(fd.fields["y"][i, j]), float(fd.fields["z"][i, j])
                    pl = pretty_place(_place_of(meta, centers, x, y, z))  # « TRamp » et « T Ramp » : un seul poste
                    pos[(sid, side)][pl or "?"] += 1
                    pos_rounds[(sid, side)].append(r.id)
                    acc = pos_sum[(sid, side, pl or "?")]  # position moyenne réelle du joueur à ce poste (radar)
                    acc[0] += x
                    acc[1] += y
                    acc[2] += z
                    acc[3] += 1

    by_side = {s: [x for x in rows if x["side"] == s] for s in ("T", "CT")}
    by_key = {(x["match_id"], x["number"]): x for x in rows}

    # ---- pistols et round suivant
    def pistols(side: str) -> dict:
        ps = [x for x in by_side[side] if x["buy"] == "pistol"]
        out = {"result": stat(sum(x["won"] for x in ps), len(ps), [x["round_id"] for x in ps]), "plays": [], "after_won": None,
               "after_lost": None}
        plays: Counter = Counter()
        play_rounds: dict[str, list[int]] = defaultdict(list)
        for x in ps:
            if side == "T":
                info = t_info.get(x["round_id"])
                key = f"{(info or {}).get('category', '?')}:{(info or {}).get('site') or 'none'}"
            else:
                info = ct_info.get(x["round_id"])
                key = (info or {}).get("setup") or "?"
            plays[key] += 1
            play_rounds[key].append(x["round_id"])
        for key, n in plays.most_common(3):
            won = sum(by_key[(x["match_id"], x["number"])]["won"] for x in ps if x["round_id"] in play_rounds[key])
            out["plays"].append({"key": key, "label": _play_label(side, key), "count": stat(n, len(ps), play_rounds[key], judge=False),
                                 "won": won})
        def follow(sel: list[dict]) -> dict | None:
            nxt = [by_key.get((x["match_id"], x["number"] + 1)) for x in sel]
            nxt = [y for y in nxt if y is not None and y["side"] == side]
            if not nxt:
                return None
            forced = [y for y in nxt if y["buy"] in ("force", "semi", "full")]
            return {"won": stat(sum(y["won"] for y in nxt), len(nxt), [y["round_id"] for y in nxt]),
                    "bought": stat(len(forced), len(nxt), [y["round_id"] for y in forced], judge=False),
                    "buys": dict(Counter(y["buy"] for y in nxt))}

        out["after_won"] = follow([x for x in ps if x["won"]])
        out["after_lost"] = follow([x for x in ps if not x["won"]])
        if side == "T":
            # pistol T perdu : si la bombe a été posée, chaque T touche 800 $ de plus (en plus des 1 400 $ de défaite),
            # assez pour forcer au round suivant ; sans pose, l'éco est presque obligatoire
            lost = [x for x in ps if not x["won"]]
            planted = lambda x: (t_info.get(x["round_id"]) or {}).get("plant_s") is not None  # noqa: E731
            out["after_lost_planted"] = follow([x for x in lost if planted(x)])
            out["after_lost_unplanted"] = follow([x for x in lost if not planted(x)])
        return out

    # ---- premier gun round de chaque mi-temps (premier round où l'équipe achète complet)
    def first_gun(side: str) -> dict:
        firsts = []
        for m in matches:
            half = [x for x in by_side[side] if x["match_id"] == m.id and x["buy"] != "pistol"]
            for lo, hi in ((1, 12), (13, 24)):
                g = next((x for x in half if lo <= x["number"] <= hi and x["buy"] == "full"), None)
                if g is not None:
                    firsts.append(g)
        return {"result": stat(sum(x["won"] for x in firsts), len(firsts), [x["round_id"] for x in firsts]),
                "numbers": dict(Counter(x["number"] for x in firsts))}

    # ---- joueurs : poste, AWP, duels d'ouverture
    round_ids = [x["round_id"] for x in rows]
    kills = list(session.scalars(select(Kill).where(Kill.round_id.in_(round_ids)))) if round_ids else []
    side_by_round = {x["round_id"]: x["side"] for x in rows}
    awp: Counter = Counter()
    open_w: Counter = Counter()
    open_l: Counter = Counter()
    open_w_rounds: dict[str, list[int]] = defaultdict(list)  # rounds où le joueur gagne / perd le duel d'ouverture
    open_l_rounds: dict[str, list[int]] = defaultdict(list)
    won_by_round = {x["round_id"]: x["won"] for x in rows}
    kills_n: Counter = Counter()
    for k in kills:
        if k.attacker in names:
            kills_n[k.attacker] += 1
            if "awp" in (k.weapon or "").lower():
                awp[k.attacker] += 1
            if k.is_opening:
                open_w[k.attacker] += 1
                open_w_rounds[k.attacker].append(k.round_id)
        if k.is_opening and k.victim in names:
            open_l[k.victim] += 1
            open_l_rounds[k.victim].append(k.round_id)
    team_awp = sum(awp.values())
    awper = awp.most_common(1)[0][0] if awp and awp.most_common(1)[0][1] >= max(3, 0.4 * team_awp) else None
    players = []
    for sid, name in names.items():
        spots = {}
        for side in ("T", "CT"):
            c = pos.get((sid, side), Counter())
            n = sum(c.values())
            spots[side] = [{"place": pretty_place(p), "count": stat(v, n, judge=False),
                            "pos": [round(s / pos_sum[(sid, side, p)][3]) for s in pos_sum[(sid, side, p)][:3]]}
                           for p, v in [x for x in c.most_common() if x[0] != "?" and "spawn" not in x[0].lower()][:3]]
        ow, ol = open_w[sid], open_l[sid]
        wr, lr = open_w_rounds[sid], open_l_rounds[sid]
        players.append({"steamid": sid, "name": name, "awper": sid == awper, "awp_kills": awp[sid], "kills": kills_n[sid],
                        "opening": stat(ow, ow + ol),
                        # implication : part des rounds de l'équipe où il prend le premier duel (analyste mousesports :
                        # implication × réussite révèle les failles) ; conversion : rounds gagnés par l'équipe ensuite
                        "opening_attempts": stat(ow + ol, len(rows), sorted(wr + lr), judge=False),
                        "after_open_win": stat(sum(won_by_round.get(x, False) for x in wr), len(wr), wr),
                        "after_open_loss": stat(sum(won_by_round.get(x, False) for x in lr), len(lr), lr),
                        "opening_sides": dict(Counter(side_by_round[x] for x in wr + lr if x in side_by_round)),
                        "spots": spots,
                        "rounds": {s: sum(pos.get((sid, s), Counter()).values()) for s in ("T", "CT")}})
    players.sort(key=lambda p: -(p["rounds"]["T"] + p["rounds"]["CT"]))
    entry = max(players, key=lambda p: p["opening"]["k"], default=None)

    # ---- utilitaires regroupés par lieu d'arrivée
    util: dict[str, list[dict]] = {"T": [], "CT": []}
    if round_ids:
        groups: dict[tuple[str, str, str], dict] = {}
        for g in session.scalars(select(Grenade).where(Grenade.round_id.in_(round_ids), Grenade.thrower.in_(list(names)))):
            kind = NADE_TYPES.get(g.type)
            if kind is None or g.detonate_x is None:
                continue
            side = side_by_round[g.round_id]
            place = pretty_place(_place_of(meta, centers, g.detonate_x, g.detonate_y, g.detonate_z or 0.0))
            if not place:
                continue
            e = groups.setdefault((side, kind, place), {"rounds": set(), "players": Counter(), "sum": [0.0, 0.0, 0.0, 0]})
            e["rounds"].add(g.round_id)
            e["players"][names[g.thrower]] += 1
            for k, v in enumerate((g.detonate_x, g.detonate_y, g.detonate_z or 0.0)):
                e["sum"][k] += v
            e["sum"][3] += 1
        for (side, kind, place), e in groups.items():
            util[side].append({"type": kind, "place": pretty_place(place), "count": stat(len(e["rounds"]), len(by_side[side]), sorted(e["rounds"]), judge=False),
                               "players": [p for p, _ in e["players"].most_common(3)],
                               "pos": [round(s / e["sum"][3]) for s in e["sum"][:3]]})  # point d'arrivée moyen (radar)
        for side in util:
            util[side] = sorted(util[side], key=lambda u: -u["count"]["k"])[:8]

    if armed:  # styles et placements recalculés sur les seuls rounds gardés
        keep = {x["round_id"] for x in rows}
        t_list = [x for x in pb["t"]["list"] if x["round_id"] in keep]
        cats: dict[str, dict] = {}
        for x in t_list:
            c = cats.setdefault(x["category"], {"n": 0, "won": 0, "rounds": [], "sites": Counter()})
            c["n"] += 1
            c["won"] += bool(x["won"])
            c["rounds"].append(x["round_id"])
            c["sites"][x.get("site") or "none"] += 1
        t_styles = [{"key": k, "label": STYLE_FR.get(k, k), "count": stat(c["n"], len(t_list), c["rounds"], judge=False),
                     "won": stat(c["won"], c["n"]), "sites": dict(c["sites"])} for k, c in sorted(cats.items(), key=lambda kv: -kv[1]["n"])]
        ct_list = [x for x in pb["ct"]["list"] if x["round_id"] in keep]
        setups: dict[str, dict] = {}
        for x in ct_list:
            c = setups.setdefault(x["setup"], {"n": 0, "won": 0, "rounds": []})
            c["n"] += 1
            c["won"] += bool(x["won"])
            c["rounds"].append(x["round_id"])
        ct_setups = [{"setup": k, "count": stat(c["n"], len(ct_list), c["rounds"], judge=False), "won": stat(c["won"], c["n"])}
                     for k, c in sorted(setups.items(), key=lambda kv: -kv[1]["n"])[:4]]
    else:
        t_styles = [{"key": c["key"], "label": STYLE_FR.get(c["key"], c["label"]), "count": stat(c["n"], pb["t"]["rounds"], c["rounds"], judge=False),
                     "won": stat(c["won"], c["n"]), "sites": pb["t"]["sites_by_category"].get(c["key"], {})}
                    for c in pb["t"]["categories"]]
        ct_setups = [{"setup": s["key"], "count": stat(s["n"], pb["ct"]["rounds"], s["rounds"], judge=False), "won": stat(s["won"], s["n"])}
                     for s in pb["ct"]["setups"][:4]]
    sites = {k: {"held": stat(v["held"], v["attacked"]), "retakes": stat(v["retakes_won"], v["plants"])}
             for k, v in pb["ct"]["sites"].items()}
    # « default puis exécution » : part des rounds default finis par une prise de site avec grenades ; et les quatre
    # fins du default (puis exécution, puis prise, aux duels, sans prise), dans l'ordre fixe DEFAULT_KINDS
    keep_ids = {x["round_id"] for x in rows}
    for s_ in t_styles:
        if s_["key"] == "default":
            dl = [x for x in pb["t"]["list"] if x["category"] == "default" and x["round_id"] in keep_ids]
            le = [x["round_id"] for x in dl if x.get("late_exec")]
            s_["late_exec"] = stat(len(le), len(dl), le, judge=False)
            s_["kinds"] = [{"key": k, "label": DEFAULT_KIND_LABELS[k], "count": stat(len(ids), len(dl), ids, judge=False),
                            "won": stat(sum(x["won"] for x in dl if x["default_kind"] == k), len(ids))}
                           for k in DEFAULT_KINDS if (ids := [x["round_id"] for x in dl if x["default_kind"] == k])]
    # prise des sites et rotation CT provoquée, sur les rounds T gardés (hors eco pour la rotation, et seulement là où
    # elle est mesurable : None quand les sites sont trop proches, comme sur Nuke)
    kept = [x for x in pb["t"]["list"] if x["round_id"] in keep_ids]
    t_armed = [x for x in kept if x["category"] != "eco" and x.get("rotation_measurable")]
    rot = [x["round_id"] for x in t_armed if x["ct_rotation_s"] is not None]
    lib = library_style_shares(session, maps, map_name, exclude=team_id)
    for s_ in t_styles:
        s_["lib_pct"] = lib["shares"].get(s_["key"])
    for s_ in ct_setups:
        s_["lib_pct"] = lib["setups"].get(s_["setup"])

    # ---- rounds à revoir (méthode des analystes : pistols d'abord, puis premiers gun rounds, forces, prises de site)
    t_list, ct_list = pb["t"]["list"], pb["ct"]["list"]
    keep = {x["round_id"] for x in rows}
    pick = lambda xs: [x["round_id"] for x in xs if x["round_id"] in keep]  # noqa: E731
    # chaque groupe reste dans un seul camp : on superpose des rounds comparables (leurs pistols T entre eux, etc.)
    word = {"T": "en attaque", "CT": "en défense"}  # le camp est aussi affiché en pastille
    review = []
    for side in ("T", "CT"):
        mine = [x for x in rows if x["side"] == side]
        review += [
            {"key": f"pistols_{side}", "side": side, "label": f"Pistols {word[side]}",
             "why": "Leurs rounds les plus réglés : comparez les départs, les placements et les premières grenades.",
             "rounds": pick([x for x in mine if x["buy"] == "pistol"])},
            {"key": f"first_gun_{side}", "side": side, "label": f"Premiers rounds avec armes {word[side]}",
             "why": "Leur plan « par défaut » quand tout le monde a un fusil.",
             "rounds": sorted(set(first_gun(side)["result"]["rounds"]))},
            {"key": f"armed_{side}", "side": side, "label": f"Rounds armés contre armés {word[side]}",
             "why": "Leur jeu normal, à armes égales : les placements et les timings qui reviennent.",
             "rounds": pick([x for x in mine if is_armed_vs_armed(x["buy"], x["opp_buy"])])},
            {"key": f"forces_{side}", "side": side, "label": f"Leurs forces {word[side]}",
             "why": "Ce qu'ils tentent avec peu d'argent : souvent un rush ou un regroupement sur un site.",
             "rounds": pick([x for x in mine if x["buy"] == "force"])},
        ]
    review += [
        {"key": "takes", "side": "T", "label": "Prises de site (exécutions, splits, fakes)", "why": "Leurs plans travaillés en attaque.",
         "rounds": pick([x for x in t_list if x["category"] in ("execute", "split", "fake")])},
        {"key": "rushes", "side": "T", "label": "Rushs", "why": "Moment et site : de quoi préparer une défense anti-rush.",
         "rounds": pick([x for x in t_list if x["category"] == "rush"])},
        {"key": "postplant_lost", "side": "T", "label": "Plants perdus", "why": "Où leur après-plant casse : positions et timings à punir.",
         "rounds": pick([x for x in t_list if x.get("plant_s") is not None and not x["won"]])},
        {"key": "retakes", "side": "CT", "label": "Retakes", "why": "Comment ils reprennent un site : par où et avec quoi.",
         "rounds": pick([x for x in ct_list if x.get("planted")])},
    ]
    review = [g for g in review if g["rounds"]]
    brief = {
        "map": map_name, "display_name": meta.display_name, "matches": len(matches), "armed": armed,
        "sides": {s: stat(sum(x["won"] for x in by_side[s]), len(by_side[s])) for s in ("T", "CT")},
        "pistols": {s: pistols(s) for s in ("T", "CT")},
        "first_gun": {s: first_gun(s) for s in ("T", "CT")},
        "t_styles": t_styles, "avg_contact_s": pb["t"]["avg_contact_s"], "avg_plant_s": pb["t"]["avg_plant_s"],
        "engage_by_site": engage_summary(kept), "ct_rotation": stat(len(rot), len(t_armed), rot, judge=False) if t_armed else None,
        "ct_setups": ct_setups, "sites": sites, "utility": util, "players": players,
        # rounds cités par les comptages → lien vers le replay 2D (match, numéro, gagné)
        "round_index": {x["round_id"]: [x["match_id"], x["number"], x["won"]] for x in rows},
        "awper": names.get(awper) if awper else None, "entry": entry["name"] if entry and entry["opening"]["k"] else None,
        "review": review, "library_teams": lib["teams"],
    }
    brief["takeaways"], brief["counters"] = _insights(brief)
    return brief


def _play_label(side: str, key: str) -> str:
    if side == "CT":
        return f"Placement {key}"
    cat, site = key.split(":")
    cat_fr = STYLE_FR.get(cat, cat)
    return f"{cat_fr} sur {SITE_LABEL.get(site, site)}" if site != "none" else f"{cat_fr}, sans site clair"


def _frac(s: dict) -> str:
    return f"{s['k']} fois sur {s['n']}"


def library_style_shares(session: Session, maps: dict[str, MapMeta], map_name: str, exclude: int | None = None) -> dict:
    """Part moyenne de chaque style T (et de chaque placement CT) chez les autres équipes de la bibliothèque sur la carte :
    la référence pour dire si une équipe est prévisible. Moyenne des équipes (pas des rounds), équipes à 6 rounds T au moins."""
    team_ids = set()
    for m in session.scalars(select(Match).where(Match.map_name == map_name)):
        team_ids |= {m.team_a_id, m.team_b_id}
    team_ids.discard(exclude)
    shares: dict[str, list[float]] = defaultdict(list)
    setups: dict[str, list[float]] = defaultdict(list)
    n_teams = 0
    for tid in team_ids:
        pb = team_playbook(session, maps, tid, map_name)
        if pb["t"]["rounds"] < 6:
            continue
        n_teams += 1
        cats = {c["key"]: c["pct"] for c in pb["t"]["categories"]}
        for k in ("rush", "execute", "split", "fake", "default", "eco"):
            shares[k].append(cats.get(k, 0.0))
        for c in pb["ct"]["setups"]:
            setups[c["key"]].append(c["pct"])
    return {"teams": n_teams, "shares": {k: round(sum(v) / len(v)) for k, v in shares.items() if v},
            "setups": {k: round(sum(v) / max(1, n_teams)) for k, v in setups.items()} if n_teams else {}}


def _insights(b: dict) -> tuple[list[dict], list[dict]]:
    """Phrases simples « à retenir » et pistes pour les contrer, chacune avec son comptage (fiabilité)."""
    take, counter = [], []
    for side, word in (("T", "en attaque (T)"), ("CT", "en défense (CT)")):
        p = b["pistols"][side]
        if p["result"]["n"]:
            line = f"Pistol {word} : gagnés {_frac(p['result'])}"
            if p["plays"]:
                line += f" ; le plus souvent : {_lc(p['plays'][0]['label'])} ({_frac(p['plays'][0]['count'])})"
            take.append({"side": side, "topic": "pistol", "text": line + ".", "stat": p["result"]})
        lost = p.get("after_lost")
        if side == "T" and (p.get("after_lost_planted") or p.get("after_lost_unplanted")):
            pl, un = p.get("after_lost_planted"), p.get("after_lost_unplanted")
            for sub, how in ((pl, "avec la bombe posée"), (un, "sans poser la bombe")):
                if sub and sub["bought"]["n"]:
                    take.append({"side": "T", "topic": "eco", "stat": sub["bought"],
                                 "text": f"Pistol T perdu {how} : ils achètent au round suivant {_frac(sub['bought'])}."})
            seen = " ; ".join(f"chez eux, {how} : achat {_frac(sub['bought'])}" for sub, how in ((pl, "après une pose"), (un, "sans pose"))
                              if sub and sub["bought"]["n"])
            counter.append({"side": "CT", "stat": (pl or un)["bought"],
                            "text": "Pistol CT : empêchez la pose. Bombe posée, chaque T touche 800 $ de plus et ils peuvent forcer "
                                    "au round 2 ; sans pose, attendez-vous plutôt à une éco" + (f" ({seen})." if seen else ".")})
            lost = None  # déjà traité, plus finement
        if lost and lost["bought"]["n"]:
            take.append({"side": side, "topic": "eco", "stat": lost["bought"],
                         "text": f"Après un pistol perdu {word}, ils achètent quand même (force) {_frac(lost['bought'])}."})
            if lost["bought"]["pct"] is not None and lost["bought"]["pct"] >= 50:
                ours = "CT" if side == "T" else "T"  # leur pistol T perdu = notre pistol CT gagné
                counter.append({"side": ours, "stat": lost["bought"],
                                "text": f"Si vous gagnez votre pistol {ours}, attendez-vous à ce qu'ils achètent quand même au "
                                        "round suivant (force) : restez groupés, jouez les distances, n'offrez pas d'armes."})
    styles = sorted(b["t_styles"], key=lambda s: -s["count"]["k"])
    if styles and styles[0]["key"] != "eco":
        s = styles[0]
        site = max(s["sites"], key=s["sites"].get) if s["sites"] else None
        take.append({"side": "T", "topic": "attack", "stat": s["count"],
                     "text": f"En attaque, leur jeu le plus fréquent est « {_lc(s['label'])} » ({_frac(s['count'])})"
                             + (f", surtout vers {SITE_LABEL.get(site, site)}." if site and site != "none" else ".")})
        if s.get("lib_pct") is not None and s["count"]["pct"] is not None and s["count"]["pct"] - s["lib_pct"] >= 15 and s["count"]["n"] >= 6:
            take.append({"side": "T", "topic": "predictable", "stat": s["count"],
                         "text": f"Prévisibles : « {_lc(s['label'])} » dans {s['count']['pct']} % de leurs rounds T, contre "
                                 f"{s['lib_pct']} % en moyenne pour les autres équipes de la bibliothèque."})
        rush = next((x for x in styles if x["key"] == "rush"), None)
        if rush and rush["count"]["pct"] and rush["count"]["pct"] >= 30:
            counter.append({"side": "CT", "stat": rush["count"],
                            "text": "Ils rushent souvent : garder des grenades anti-rush (molotov, HE) et ne pas jouer trop "
                                    "avancé en début de round."})
    if b["ct_setups"]:
        s = b["ct_setups"][0]
        take.append({"side": "CT", "topic": "defense", "stat": s["count"],
                     "text": f"En défense, leur placement habituel à 20 s est {s['setup']} ({_frac(s['count'])})."})
    weak = [(k, v["held"]) for k, v in b["sites"].items() if v["held"]["n"] >= 3]
    if weak:
        site, held = min(weak, key=lambda kv: kv[1]["pct"] or 0)
        take.append({"side": "CT", "topic": "defense", "stat": held,
                     "text": f"Site qu'ils tiennent le moins bien : {site} (tenu {_frac(held)} quand il est attaqué)."})
        counter.append({"side": "T", "stat": held,
                        "text": f"Attaquer le site {site} : c'est celui qu'ils perdent le plus souvent."})
    if b["awper"]:
        aw = next(p for p in b["players"] if p["name"] == b["awper"])
        spot = aw["spots"]["CT"][0]["place"] if aw["spots"]["CT"] else None
        take.append({"side": "CT", "topic": "player", "stat": aw["spots"]["CT"][0]["count"] if spot else stat(0, 0),
                     "text": f"Leur AWPer est {b['awper']}" + (f", souvent à {spot} en CT." if spot else ".")})
        if spot:
            counter.append({"side": "T", "stat": aw["spots"]["CT"][0]["count"],
                            "text": f"Ne pas prendre seul le duel contre l'AWP à {spot} : flasher ou smoker cet angle, "
                                    "et le prendre à deux."})
    if b["entry"]:
        e = next(p for p in b["players"] if p["name"] == b["entry"])
        take.append({"side": "T", "topic": "player", "stat": e["opening"],
                     "text": f"{b['entry']} prend le plus de premiers duels : gagnés {_frac(e['opening'])}."})
        counter.append({"side": "CT", "stat": e["opening"],
                        "text": f"Surveiller {b['entry']} : prévoir un coéquipier prêt à le reprendre (trade) dès qu'il "
                                "ouvre un duel."})
    for p in b["players"]:
        att, op = p.get("opening_attempts"), p["opening"]
        sides_ = p.get("opening_sides") or {}
        their = max(sides_, key=sides_.get) if sides_ else "T"  # camp où il prend le plus de premiers duels
        ours = "CT" if their == "T" else "T"
        if att and att["n"] and op["n"] >= 5 and att["pct"] is not None and att["pct"] >= 20 and op["pct"] is not None and op["pct"] <= 40:
            take.append({"side": their, "topic": "opening", "stat": op,
                         "text": f"{p['name']} prend souvent le premier duel ({att['pct']} % des rounds) mais le perd souvent "
                                 f"(gagné {_frac(op)}) : leur équipe joue alors en infériorité."})
            counter.append({"side": ours, "stat": op,
                            "text": f"Acceptez le premier duel contre {p['name']} : il ouvre souvent et le perd plus qu'il ne le gagne."})
        aw = p.get("after_open_win")
        if aw and aw["n"] >= 4 and aw["pct"] is not None and aw["pct"] >= 75:
            take.append({"side": their, "topic": "opening", "stat": aw,
                         "text": f"Quand {p['name']} gagne le premier duel, ils gagnent le round {_frac(aw)} : c'est leur déclencheur."})
    return take, counter
