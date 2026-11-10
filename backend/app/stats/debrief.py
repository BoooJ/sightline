# backend/app/stats/debrief.py
"""Débrief d'un match pour une équipe, et mesures suivies match après match (axes de travail).

Méthode reprise des analystes et de la recherche sur les débriefs d'équipe (after-action reviews) :
1. l'histoire du match d'abord (où les rounds se sont perdus : pistols, conversions, rounds armés, avantages
   numériques, après le plant, retakes) ;
2. peu de problèmes, ceux qui reviennent (3 au plus), comparés à la forme habituelle de l'équipe ;
3. quelques rounds à revoir en vidéo (pistol, round qui a échappé, avantage perdu, clutch, et un round réussi) ;
4. des conclusions écrites et des axes de travail mesurés, suivis aux matchs suivants.

Chaque mesure est un comptage « k sur n » sur un seul match ; la référence est la moyenne des autres matchs de la
même équipe (repli sur un repère fixe quand l'équipe a trop peu de matchs)."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.stats.brief import stat
from app.storage.models import BombEvent, Kill, Match, Round, TeamGoal

# better : « up » = plus haut c'est mieux ; « down » = plus bas c'est mieux (ex. morts évitables).
# ref : part « mauvaise » considérée comme normale quand l'équipe n'a pas d'historique. Calée sur la bibliothèque
#       (13 matchs, 5 pros et 8 FACEIT, octobre 2026), où pros et amateurs sont proches : 22 à 24 % de morts
#       échangées, 30 à 34 % de morts évitables, 43 à 59 % de morts avec une grenade en poche, 77 % de rounds gagnés
#       après le plant, 22 % de retakes réussis, 75 à 88 % de rounds 2 gagnés après un pistol gagné ; 28 % des defaults
#       sans prise du site (45 sur 161), 63 % des pressions sans rotation CT (107 sur 170, hors Nuke où la rotation
#       n'est pas mesurable ; règles du 16/10/2026, sans les poses faites après la fin du round depuis le 20/10).
# drill : comment le travailler à l'entraînement (exercice), question : ce qu'il faut chercher dans la démo.
METRICS: dict[str, dict] = {
    "rounds": {"label": "Rounds gagnés", "unit": "rounds", "better": "up", "ref": 0.5},
    "t_side": {"label": "Rounds gagnés en T", "unit": "rounds", "better": "up", "ref": 0.5},
    "ct_side": {"label": "Rounds gagnés en CT", "unit": "rounds", "better": "up", "ref": 0.5},
    "pistols": {"label": "Pistols gagnés", "unit": "pistols", "better": "up", "ref": 0.5,
                "drill": "Rejouer vos pistols prévus contre plusieurs placements ; fixer un plan T et un plan CT par carte.",
                "question": "Le plan était-il clair pour tous ? Les duels se sont-ils pris à deux ?"},
    "conversion": {"label": "Round suivant un pistol gagné", "unit": "rounds", "better": "up", "ref": 0.2,
                   "drill": "Préparer un placement anti-force (rester groupés, jouer les distances, ne pas offrir d'armes).",
                   "question": "Qui est mort seul face aux armes de l'adversaire ? Quelle arme lui a-t-on laissée ?"},
    "force_after_plant": {"label": "Achat au round 2 après un pistol T perdu avec la bombe posée", "unit": "rounds", "better": "up", "ref": 0.1,
                          "question": "Avec les 800 $ du plant, l'équipe pouvait forcer : l'appel a-t-il été fait ?"},
    "conv_vs_force": {"label": "Round 2 gagné quand ils avaient posé au pistol (contre un force)", "unit": "rounds", "better": "up", "ref": 0.5,
                      "question": "Ils avaient de quoi forcer : vous êtes-vous placés contre des armes, groupés et à distance ?"},
    "armed": {"label": "Rounds armés contre armés gagnés", "unit": "rounds", "better": "up", "ref": 0.5,
              "drill": "Travailler les défauts et une exécution par site en entraînement, avec les mêmes grenades à chaque fois.",
              "question": "Le round a-t-il été perdu au premier contact, pendant la prise du site ou après ?"},
    "opening": {"label": "Duels d'ouverture gagnés", "unit": "duels", "better": "up", "ref": 0.5,
                "drill": "Revoir les positions de premier contact ; serveurs de pré-visée et de duels sur ces angles.",
                "question": "Le premier duel était-il pris avec une info, une flash ou un coéquipier prêt à reprendre ?"},
    "after_open_win": {"label": "Rounds gagnés après la première élimination (5v4)", "unit": "rounds", "better": "up", "ref": 0.28,
                       "drill": "Fixer une règle à 5 contre 4 : se regrouper, jouer les échanges, ne pas chasser seul.",
                       "question": "Qu'avez-vous fait juste après la première élimination ? Quelqu'un est-il parti seul ?"},
    "after_open_loss": {"label": "Rounds gagnés après la première mort (4v5)", "unit": "rounds", "better": "up", "ref": 0.7,
                        "question": "Le plan a-t-il été adapté après la première mort, ou le round a-t-il continué comme prévu ?"},
    "advantage": {"label": "Avantages numériques convertis", "unit": "rounds", "better": "up", "ref": 0.28,
                  "drill": "Scénarios en 5v4 / 4v3 à l'entraînement : temps restant, utilitaires gardés, qui prend l'info.",
                  "question": "Comment l'avantage s'est-il perdu : duel inutile, rotation lente, temps mal géré ?"},
    "traded": {"label": "Morts échangées", "unit": "morts", "better": "up", "ref": 0.77,
               "drill": "Travail en binôme : distance d'échange, qui passe en premier, flash pour le partenaire.",
               "question": "Le coéquipier le plus proche pouvait-il voir le tueur ? Était-il trop loin ou trop près ?"},
    "avoidable": {"label": "Morts évitables", "unit": "morts", "better": "down", "ref": 0.33,
                  "drill": "Revue des morts une par une : position, info disponible, et règle simple à appliquer.",
                  "question": "Le joueur était-il isolé, pris à revers, ou avec de l'équipement à sauver ?"},
    "utility_death": {"label": "Morts avec des grenades non lancées", "unit": "morts", "better": "down", "ref": 0.5,
                      "drill": "Fixer pour chaque poste une grenade à lancer avant le contact (lineups à l'entraînement).",
                      "question": "Quelle grenade aurait aidé ce duel, et à quel moment fallait-il la lancer ?"},
    "wasted_utility": {"label": "Rounds avec grenades non lancées", "unit": "rounds", "better": "down", "ref": 0.53,
                       "drill": "Une grenade par poste à lancer avant le contact, et plus aucune en poche à la mi-temps ou en fin de match.",
                       "question": "Quelle grenade est restée en poche, et à quel moment du round fallait-il la lancer ?"},
    "dry": {"label": "Duels pris à sec", "unit": "morts", "better": "down", "ref": 0.55,
            "drill": "Ne pas prendre un duel sans aide : flash d'un coéquipier, molotov ou smoke devant l'angle, ou à deux.",
            "question": "Qu'est-ce qui aidait l'adversaire dans ce duel, et qu'est-ce qui manquait de votre côté ?"},
    "off_aim": {"label": "Morts hors du viseur (> 45°)", "unit": "morts", "better": "down", "ref": 0.18,
                "drill": "Vérifier chaque angle avant de le passer (pré-visée, shoulder peek) et ne pas tourner le dos aux couloirs ouverts.",
                "question": "D'où est venu le tueur, et pourquoi cet angle n'était-il pas regardé ?"},
    "postplant": {"label": "Rounds T gagnés après le plant", "unit": "rounds", "better": "up", "ref": 0.23,
                  "drill": "Positions après le plant par site : angles croisés, molotov gardée pour le désamorçage.",
                  "question": "Où étiez-vous après le plant ? Qui gardait une grenade pour empêcher le désamorçage ?"},
    "retakes": {"label": "Retakes gagnés (CT)", "unit": "rounds", "better": "up", "ref": 0.78,
                "drill": "Serveurs de retake : se regrouper, entrer ensemble avec les grenades gardées.",
                "question": "Le retake est-il parti groupé, avec des grenades, et dans les temps ?"},
    "saves": {"label": "Équipement perdu dans un round perdu d'avance", "unit": "morts", "better": "down", "ref": 0.5,
              "drill": "Fixer avec l'IGL quand sauver : appel clair à partir de quel nombre de joueurs et de quel temps.",
              "question": "Le round était-il encore jouable ? L'appel de sauvegarde a-t-il été fait ?"},
    "default_take": {"label": "Defaults avec prise du site", "unit": "rounds", "better": "up", "ref": 0.28,
                     "drill": "Fixer pour chaque default le moment et le site de la prise : trois joueurs ensemble sur le site, avec les grenades d'exécution, et l'info qui la déclenche.",
                     "question": "Le default s'est-il fini en duels isolés ? Quelle info ou quel moment aurait dû lancer la prise du site ?"},
    "ct_rotated": {"label": "Pressions qui ont fait tourner un CT", "unit": "rounds", "better": "up", "ref": 0.63,
                   "drill": "Montrer la pression sur un site (deux grenades ou deux joueurs), attendre l'info de rotation, puis frapper l'autre site.",
                   "question": "Après votre pression, un CT a-t-il quitté l'autre site ? Avez-vous frappé là où il manquait ?"},
}
ISSUE_KEYS = ("traded", "avoidable", "utility_death", "advantage", "opening", "after_open_win", "postplant", "retakes",
              "conversion", "saves", "pistols", "armed", "dry", "off_aim", "default_take")
PHASE_KEYS = ("pistols", "conversion", "conv_vs_force", "force_after_plant", "armed", "default_take", "ct_rotated", "opening",
              "after_open_win", "after_open_loss", "postplant", "retakes")
ARMED = ("full", "force")
MIN_BASE = 8  # en dessous, la référence est le repère fixe


def team_match_metrics(session: Session, match_id: int, team_id: int, analysis: dict,
                       t_rounds: list[dict] | None = None) -> dict[str, dict]:
    """Toutes les mesures d'une équipe sur un match : {clé: {k, n, bad: [numéros de rounds où ça a mal tourné]}}.
    `t_rounds` : lignes T du playbook du match (playbook.match_t_rounds), pour la prise du site et la rotation CT."""
    rounds = list(session.scalars(select(Round).where(Round.match_id == match_id).order_by(Round.number)))
    by_num = {r.number: r for r in rounds}
    rid = {r.id: r for r in rounds}
    out = {k: {"k": 0, "n": 0, "bad": []} for k in METRICS}

    def add(key: str, ok: bool, number: int) -> None:
        m = out[key]
        m["n"] += 1
        m["k"] += bool(ok)
        if (not ok) if METRICS[key]["better"] == "up" else ok:
            m["bad"].append(number)

    side_of = {r.number: ("CT" if r.ct_team_id == team_id else "T") for r in rounds}
    rids0 = [r.id for r in rounds]
    plants = {b.round_id for b in session.scalars(select(BombEvent).where(BombEvent.round_id.in_(rids0), BombEvent.type == "plant"))} if rids0 else set()
    won = {r.number: r.winner_side == side_of[r.number] for r in rounds}
    for r in rounds:
        s = side_of[r.number]
        add("rounds", won[r.number], r.number)
        add("t_side" if s == "T" else "ct_side", won[r.number], r.number)
        if r.number in (1, 13):
            add("pistols", won[r.number], r.number)
            nxt = by_num.get(r.number + 1)
            if won[r.number] and nxt is not None:
                add("conversion", won[nxt.number], nxt.number)
        mine, theirs = (r.ct_buy_type, r.t_buy_type) if s == "CT" else (r.t_buy_type, r.ct_buy_type)
        prev = by_num.get(r.number - 1)
        if prev is not None and prev.number in (1, 13) and prev.id in plants and side_of[prev.number] == s:
            if s == "T" and not won[prev.number]:  # notre pistol T perdu, bombe posée : on pouvait forcer
                add("force_after_plant", mine in ("force", "semi", "full"), r.number)
            if s == "CT" and won[prev.number]:  # notre pistol CT gagné malgré leur plant : ils pouvaient forcer
                add("conv_vs_force", won[r.number], r.number)
        if mine in ARMED and theirs in ARMED and r.number not in (1, 13):
            add("armed", won[r.number], r.number)

    rids = list(rid)
    kills = list(session.scalars(select(Kill).where(Kill.round_id.in_(rids), Kill.is_opening))) if rids else []
    for k in kills:
        r = rid[k.round_id]
        s = side_of[r.number]
        # ouverture gagnée : le tueur est de notre camp (repli sur le camp de la victime)
        ours = k.attacker_side == s if k.attacker_side else (k.victim_side is not None and k.victim_side != s)
        add("opening", ours, r.number)
        add("after_open_win" if ours else "after_open_loss", won[r.number], r.number)

    for r in rounds:
        if r.id in plants:
            add("postplant" if side_of[r.number] == "T" else "retakes", won[r.number], r.number)

    adv = (analysis.get("advantages") or {}).get(str(team_id)) or {}
    lost_adv = sorted({x["round"] for x in analysis.get("lost_advantages", []) if x["team_id"] == team_id})
    out["advantage"] = {"k": adv.get("won", 0), "n": adv.get("had", 0), "bad": lost_adv}

    deaths = [d for d in analysis.get("deaths", []) if d.get("team_id") == team_id]
    per_round: dict[int, list[dict]] = defaultdict(list)
    for d in deaths:
        per_round[d["round"]].append(d)
    for num, ds in per_round.items():
        ds.sort(key=lambda d: d["tick"])
        for i, d in enumerate(ds):
            rs = d["reasons"]
            if i < 4:  # la cinquième mort d'un round ne peut pas être échangée
                add("traded", "untraded" not in rs, num)
            add("avoidable", bool(d.get("avoidable")), num)
            add("utility_death", (d.get("unused_utility") or 0) > 0, num)
            if d.get("aim_zone"):
                add("dry", "dry" in rs, num)
                add("off_aim", d["aim_zone"] in ("cote", "dos"), num)
            if "lost_cause" in rs:
                add("saves", "saveable" in rs, num)
    # grenades perdues : joueurs-rounds morts ou survivants d'une fin de mi-temps / de match, avec des grenades en poche
    for e in (analysis.get("utility") or {}).get("rounds", []):
        if e["team_id"] == team_id:
            add("wasted_utility", e["value"] > 0, e["round"])
    for x in t_rounds or []:      # lignes du playbook (match_t_rounds) : prise du site et rotation CT
        if x["category"] == "eco":
            continue
        if x["category"] == "default":
            add("default_take", x["engage_s"] is not None, x["number"])
        if x["pressure_s"] is not None and x.get("rotation_measurable"):   # pas si les sites sont trop proches (Nuke)
            add("ct_rotated", x["ct_rotation_s"] is not None, x["number"])
    for m in out.values():
        m["bad"] = sorted(set(m["bad"]))
    return out


def _when(m: Match) -> datetime:
    return m.played_at or (m.demo.imported_at if m.demo else None) or datetime.min


def team_matches(session: Session, team_id: int) -> list[Match]:
    ms = list(session.scalars(select(Match).where((Match.team_a_id == team_id) | (Match.team_b_id == team_id))))
    return sorted(ms, key=lambda m: (_when(m), m.id))


def _pct(k: int, n: int) -> float | None:
    return round(100 * k / n) if n else None


def _bad_rate(metric: str, k: int, n: int) -> float:
    return (n - k) / n if METRICS[metric]["better"] == "up" else k / n


def match_debrief(session: Session, match: Match, team_id: int, metrics_of) -> dict:
    """`metrics_of(match_id)` : mesures de l'équipe sur un match (en cache côté API)."""
    cur = metrics_of(match.id)
    others = [m for m in team_matches(session, team_id) if m.id != match.id]
    base: dict[str, list[int]] = {k: [0, 0] for k in METRICS}
    for m in others:
        for key, v in metrics_of(m.id).items():
            base[key][0] += v["k"]
            base[key][1] += v["n"]
    rounds = {r.number: r for r in session.scalars(select(Round).where(Round.match_id == match.id))}
    by_round = lambda nums: [rounds[x].id for x in nums if x in rounds]  # noqa: E731

    def row(key: str) -> dict:
        v, (bk, bn) = cur[key], base[key]
        return {"key": key, "label": METRICS[key]["label"], "better": METRICS[key]["better"], "unit": METRICS[key]["unit"],
                "stat": stat(v["k"], v["n"], by_round(v["bad"]), judge=METRICS[key]["better"] == "up"),
                "usual": _pct(bk, bn) if bn >= MIN_BASE else None, "usual_n": bn, "bad": v["bad"]}

    phases = [row(k) for k in PHASE_KEYS if cur[k]["n"]]
    sides = [row(k) for k in ("t_side", "ct_side")]

    # problèmes : « mauvais » comptes au-delà de ce qu'on attendrait (forme habituelle, sinon repère fixe)
    issues = []
    for key in ISSUE_KEYS:
        v = cur[key]
        if v["n"] < 2:
            continue
        bad = round(_bad_rate(key, v["k"], v["n"]) * v["n"])
        bk, bn = base[key]
        usual_bad = _bad_rate(key, bk, bn) if bn >= MIN_BASE else None
        expected = (usual_bad if usual_bad is not None else METRICS[key]["ref"]) * v["n"]
        excess = bad - expected
        if bad < 2 or excess < max(1.5, 0.1 * v["n"]):  # écart net, pas une variation d'un ou deux rounds
            continue
        meta = METRICS[key]
        up = meta["better"] == "up"
        usual_pct = _pct(bk, bn) if bn >= MIN_BASE else None
        ref_pct = round(100 * ((1 - meta["ref"]) if up else meta["ref"]))
        ref_txt = f"{usual_pct} % d'habitude" if usual_pct is not None else f"repère {ref_pct} %"
        text = f"{meta['label']} : {v['k']} sur {v['n']} ({_pct(v['k'], v['n'])} %, contre {ref_txt})."
        issues.append({"key": key, "label": meta["label"], "text": text, "excess": round(excess, 1),
                       "stat": stat(v["k"], v["n"], by_round(v["bad"]), judge=meta["better"] == "up"),
                       "usual": _pct(bk, bn) if bn >= MIN_BASE else None, "bad_rounds": v["bad"],
                       "drill": meta.get("drill"), "question": meta.get("question")})
    issues.sort(key=lambda x: -x["excess"])
    issues = issues[:3]  # « moins c'est plus » : trois problèmes au plus

    review = _review_rounds(match, team_id, rounds, cur)
    return {"match_id": match.id, "team_id": team_id, "matches_compared": len(others),
            "phases": phases, "sides": sides, "issues": issues, "review": review,
            "metrics": {k: {"k": v["k"], "n": v["n"], "pct": _pct(v["k"], v["n"])} for k, v in cur.items()}}


def _review_rounds(match: Match, team_id: int, rounds: dict[int, Round], cur: dict) -> list[dict]:
    """Cinq rounds à revoir (méthode « pistol, round armé, avantage perdu, clutch, round réussi »)."""
    side = {n: ("CT" if r.ct_team_id == team_id else "T") for n, r in rounds.items()}
    won = {n: r.winner_side == side[n] for n, r in rounds.items()}
    out, used = [], set()

    def push(n: int | None, kind: str, label: str, why: str) -> None:
        if n is None or n in used or n not in rounds:
            return
        used.add(n)
        out.append({"number": n, "round_id": rounds[n].id, "kind": kind, "label": label, "why": why, "won": won[n], "side": side[n]})

    pistols = [n for n in (1, 13) if n in rounds]
    lost_p = [n for n in pistols if not won[n]]
    push((lost_p or pistols or [None])[0], "pistol", "Pistol" + (" perdu" if lost_p else ""),
         "Le plan de pistol a-t-il été appliqué ? Qui a pris les premiers duels, et à deux ?")
    lost_adv = cur["advantage"]["bad"]
    push(lost_adv[0] if lost_adv else None, "advantage", "Avantage numérique perdu",
         "Vous étiez en surnombre : repérez la décision qui a rendu le round à l'adversaire.")
    # un default perdu aux duels (pas « sans prise » : temps écoulé, personne ne s'est battu) passe avant le round
    # armé perdu
    dd = [n for n in cur["default_take"]["bad"]
          if not won[n] and n not in used and rounds[n].end_reason != "time_ran_out"]
    if dd:
        push(dd[0], "default_duels", "Default perdu aux duels",
             "Pas de prise du site : le round s'est joué en duels isolés. Où et quand fallait-il se regrouper pour prendre le site ?")
    else:
        armed_lost = [n for n in cur["armed"]["bad"] if n not in used]
        push(armed_lost[0] if armed_lost else None, "armed", "Round armé perdu",
             "Rounds à armes égales : perdu au premier contact, pendant la prise du site ou après ?")
    postplant = [n for n in cur["postplant"]["bad"] + cur["retakes"]["bad"] if n not in used]
    push(postplant[0] if postplant else None, "late", "Fin de round perdue (après le plant ou retake)",
         "Positions et temps : où étiez-vous, qui gardait une grenade, l'horloge a-t-elle été bien gérée ?")
    good = [n for n in sorted(rounds) if won[n] and n not in used and rounds[n].ct_buy_type in ARMED and rounds[n].t_buy_type in ARMED]
    push(good[0] if good else None, "good", "Round réussi à reproduire",
         "Ce qui a marché : le garder dans le playbook et le refaire volontairement.")
    return out


def goal_progress(session: Session, goal: TeamGoal, metrics_of) -> dict:
    """Valeur de la mesure à chaque match de l'équipe, avant et après la création de l'axe de travail."""
    series, before, after = [], [0, 0], [0, 0]
    for m in team_matches(session, goal.team_id):
        v = metrics_of(m.id).get(goal.metric) or {"k": 0, "n": 0}
        is_after = goal.created_at is not None and _when(m) >= goal.created_at.replace(tzinfo=None)
        if m.id == goal.source_match_id:
            is_after = False
        acc = after if is_after else before
        acc[0] += v["k"]
        acc[1] += v["n"]
        opp = m.team_b if m.team_a_id == goal.team_id else m.team_a
        series.append({"match_id": m.id, "date": _when(m).isoformat() if _when(m) != datetime.min else None,
                       "map": m.map_name, "opponent": opp.name if opp else "?", "k": v["k"], "n": v["n"],
                       "pct": _pct(v["k"], v["n"]), "after": is_after})
    meta = METRICS.get(goal.metric, {"better": "up"})
    b, a = _pct(*before), _pct(*after)
    if not after[1]:
        status = "waiting"
    elif b is None or after[1] < 3:
        status = "early"
    else:
        gain = (a - b) if meta["better"] == "up" else (b - a)
        status = "better" if gain >= 5 else "worse" if gain <= -5 else "flat"
    reached = None
    if goal.target is not None and a is not None:
        reached = a >= goal.target if meta["better"] == "up" else a <= goal.target
    return {"before": stat(*before, judge=False), "after": stat(*after, judge=False), "status": status,
            "reached": reached, "series": series}
