# backend/app/stats/routine.py
"""Routine d'un joueur sur ses rounds armés (« Apprendre un rôle », étape 3 du plan
docs/superpowers/specs/2026-10-13-apprendre-un-role-v2.md).

À partir des histoires de rounds (app.stats.story) : achat habituel, poste à 0:10 / 0:20 / 0:40 / 1:00, grenades
(type, destination, moment habituel), rotations, lieux de mort. Chaque fréquence est un comptage « k sur n » avec sa
fiabilité (app.stats.brief.stat). Portée : la démo choisie, ou toutes les démos de la carte où joue le joueur."""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.stats.brief import pretty_place, stat
from app.stats.story import player_story
from app.storage.models import Match, MatchPlayer

TIMES_S = (10, 20, 40, 60)  # instants étudiés, en secondes après la fin du freeze time
ROUND_S = 115
ARMED = ("full",)
MAX_MATCHES = 12


def _clock(t: float) -> str:
    """Horloge du jeu (1:55 au début du round)."""
    left = max(0, round(ROUND_S - t))
    return f"{left // 60}:{left % 60:02d}"


GEAR = ("Kevlar + casque", "Kevlar", "Kit")
NADES = ("Smoke", "Flash", "HE", "Molotov", "Incendiaire")


def _kit(items: list[str], weapon: str | None = None) -> list[str]:
    """Équipement d'un round, élément par élément : arme principale (achetée ou gardée du round précédent), protections
    et grenades achetées. Les armes achetées en plus (pour un coéquipier) ne comptent pas."""
    names = {"Kevlar & Helmet": "Kevlar + casque", "Kevlar Vest": "Kevlar", "Defuse Kit": "Kit", "Smoke Grenade": "Smoke",
             "Flashbang": "Flash", "High Explosive Grenade": "HE", "Incendiary Grenade": "Incendiaire",
             "Molotov": "Molotov", "Decoy Grenade": "Leurre"}
    got = [names.get(i, i) for i in items]
    weapons = [weapon] if weapon else [k for k in got if k not in GEAR and k not in NADES and k != "Leurre"][:1]
    return weapons + [k for k in GEAR if k in got] + [k for k in NADES if k in got]


def player_routine(session: Session, maps: dict[str, MapMeta], steamid: str, match_id: int, side: str,
                   scope: str = "match", armed_only: bool = True, story_of=None) -> dict | None:
    """`story_of(match_id)` : histoire d'un match pour ce joueur (permet de passer par le cache de l'API)."""
    m = session.get(Match, match_id)
    if m is None:
        return None
    story_of = story_of or (lambda mid: player_story(session, maps, mid, steamid))
    ids = [match_id]
    if scope == "map":  # toutes ses démos sur cette carte, les plus récentes d'abord
        ids = list(session.scalars(select(Match.id).join(MatchPlayer, MatchPlayer.match_id == Match.id)
                                   .where(MatchPlayer.steamid == steamid, Match.map_name == m.map_name)
                                   .order_by(Match.id.desc()).limit(MAX_MATCHES)))
    rounds = []
    name = None
    for mid in ids:
        st = story_of(mid)
        if not st:
            continue
        name = name or st["name"]
        for r in st["rounds"]:
            if r["side"] == side and (not armed_only or r["buy"] in ARMED):
                rounds.append((mid, r))
    n = len(rounds)
    ref = [{"match_id": mid, "number": r["number"], "won": r["won"]} for mid, r in rounds]
    rid = lambda i: i  # noqa: E731 — index dans `rounds` (sert de référence de round)

    # achat habituel
    buy_step = lambda r: next((s for s in r["steps"] if s["kind"] == "buy"), {})  # noqa: E731
    kits = [_kit(buy_step(r).get("items") or [], buy_step(r).get("weapon")) for _, r in rounds]
    weapons = Counter(k[0] for k in kits if k and k[0] not in GEAR and k[0] not in NADES)
    bought = Counter(x for k in kits for x in k if x in GEAR or x in NADES)
    # grenades achetées puis restées en poche (à la mort ou en fin de round) : par grenade, k rounds sur les n où elle est achetée
    left = [set(_kit(buy_step(r).get("unused") or [])) for _, r in rounds]
    unused = Counter(x for k, lf in zip(kits, left) for x in k if x in NADES and x in lf)
    # postes dans le temps
    at: dict[int, Counter] = {t: Counter() for t in TIMES_S}
    at_alive = {t: 0 for t in TIMES_S}
    at_pos: dict[tuple[int, str], list] = defaultdict(lambda: [0.0, 0.0, 0.0, 0])
    at_rounds: dict[tuple[int, str], list[int]] = defaultdict(list)
    for i, (_, r) in enumerate(rounds):
        path = r["path"]
        steps_place = [s for s in r["steps"] if s["kind"] == "place"]
        for t in TIMES_S:
            pt = next((p for p in path if p[0] >= t), None)
            if pt is None:
                continue
            at_alive[t] += 1
            # nom du lieu : celui de la dernière étape « placement » avant t, sinon celui du premier placement
            pl = next((s["place"] for s in reversed(steps_place) if s["t"] <= t), steps_place[0]["place"] if steps_place else None)
            pl = pretty_place(pl) or "?"
            at[t][pl] += 1
            acc = at_pos[(t, pl)]
            for k in range(3):
                acc[k] += pt[k + 1]
            acc[3] += 1
            at_rounds[(t, pl)].append(rid(i))
    # grenades : type, destination, moment habituel
    nades: dict[tuple[str, str], dict] = {}
    for i, (_, r) in enumerate(rounds):
        seen = set()
        for s in r["steps"]:
            if s["kind"] != "nade":
                continue
            key = (s.get("nade") or "?", pretty_place(s.get("target_place")) or pretty_place(s.get("place")) or "?")
            e = nades.setdefault(key, {"rounds": [], "t": [], "target": [0.0, 0.0, 0.0, 0], "from": Counter()})
            if key not in seen:
                e["rounds"].append(rid(i))
                seen.add(key)
            e["t"].append(s["t"])
            if s.get("target"):
                for k in range(3):
                    e["target"][k] += s["target"][k]
                e["target"][3] += 1
            if s.get("place"):
                e["from"][pretty_place(s["place"])] += 1
    # rotations et morts
    rot = Counter()
    rot_rounds: dict[str, list[int]] = defaultdict(list)
    deaths = Counter()
    death_rounds: dict[str, list[int]] = defaultdict(list)
    for i, (_, r) in enumerate(rounds):
        for s in r["steps"]:
            if s["kind"] == "place" and not s.get("first"):
                p = pretty_place(s["place"]) or "?"
                rot[p] += 1
                rot_rounds[p].append(rid(i))
            if s["kind"] == "death":
                p = pretty_place(s.get("place")) or "?"
                deaths[p] += 1
                death_rounds[p].append(rid(i))

    def with_rounds(s: dict, idx: list[int]) -> dict:
        return {**s, "rounds": [], "refs": [ref[i] for i in idx[:12]]}

    times = []
    for t in TIMES_S:
        places = []
        for pl, v in at[t].most_common(3):
            acc = at_pos[(t, pl)]
            places.append({"place": pl, "count": with_rounds(stat(v, at_alive[t], judge=False), at_rounds[(t, pl)]),
                           "pos": [round(acc[k] / acc[3]) for k in range(3)] if acc[3] else None})
        times.append({"t": t, "clock": _clock(t), "alive": at_alive[t], "places": places})
    nade_rows = []
    for (typ, place), e in sorted(nades.items(), key=lambda kv: -len(kv[1]["rounds"]))[:8]:
        med = statistics.median(e["t"])
        nade_rows.append({"type": typ, "place": place, "count": with_rounds(stat(len(e["rounds"]), n, judge=False), e["rounds"]),
                          "median_t": round(med, 1), "clock": _clock(med),
                          "early_clock": _clock(min(e["t"])), "late_clock": _clock(max(e["t"])),
                          "from": [p for p, _ in e["from"].most_common(2)],
                          "pos": [round(e["target"][k] / e["target"][3]) for k in range(3)] if e["target"][3] else None})
    won = sum(1 for _, r in rounds if r["won"])
    return {
        "name": name, "map": m.map_name, "side": side, "scope": scope, "armed_only": armed_only,
        "matches": len({mid for mid, _ in rounds}), "rounds": n, "won": stat(won, n),
        # une ligne par élément : ses armes (les plus jouées), puis ce qu'il achète (protections, grenades)
        "buys": [{"buy": b, "kind": "weapon", "count": stat(v, n, judge=False)} for b, v in weapons.most_common(3)]
        + [{"buy": b, "kind": "item", "count": stat(v, n, judge=False),
            **({"unused": stat(unused[b], v, judge=False)} if b in NADES else {})} for b, v in bought.most_common() if v * 4 >= n],
        "times": times, "nades": nade_rows,
        "rotations": [with_rounds({"place": p, "count": stat(v, n, judge=False)}, rot_rounds[p]) for p, v in rot.most_common(4)],
        "deaths": [with_rounds({"place": p, "count": stat(v, n, judge=False)}, death_rounds[p]) for p, v in deaths.most_common(4)],
    }
