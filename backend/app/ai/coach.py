# backend/app/ai/coach.py
"""L'IA comme coach dans « Apprendre un rôle » (étape 4 du plan docs/superpowers/specs/2026-10-13-apprendre-un-role-v2.md).

Même méthode que le rapport de scouting : les faits sont calculés en code (histoire du round, routine du joueur), l'IA
rédige en citant leurs identifiants, et chaque nombre, comptage et horloge est vérifié (app.ai.report).
- « Explique-moi ce round » : récit simple du round du point de vue du joueur, et ce qu'il faut reproduire ;
- « Comment jouer ce poste comme lui » : guide débutant tiré de sa routine sur ses rounds armés."""
from __future__ import annotations

from app.ai import report
from app.stats.brief import pretty_place

ROUND_S = 115
BOMB_S = 40
NADE = {"smoke": "une smoke", "flash": "une flash", "he": "une HE", "molotov": "un molotov", "incendiary": "une incendiaire",
        "decoy": "un leurre"}
WEAPON = {"m4a1_silencer": "M4A1-S", "m4a1": "M4A4", "usp_silencer": "USP-S", "hkp2000": "P2000", "glock": "Glock",
          "ak47": "AK-47", "awp": "AWP", "deagle": "Desert Eagle", "famas": "FAMAS", "galilar": "Galil", "ssg08": "Scout",
          "aug": "AUG", "sg556": "SG 553", "mp9": "MP9", "mac10": "MAC-10", "mp7": "MP7", "mp5sd": "MP5-SD",
          "ump45": "UMP-45", "p90": "P90", "bizon": "PP-Bizon", "tec9": "Tec-9", "fiveseven": "Five-SeveN",
          "cz75a": "CZ75", "p250": "P250", "elite": "Dual Berettas", "revolver": "R8", "nova": "Nova", "xm1014": "XM1014",
          "mag7": "MAG-7", "sawedoff": "Sawed-Off", "negev": "Negev", "m249": "M249", "g3sg1": "G3SG1", "scar20": "SCAR-20",
          "hegrenade": "HE", "inferno": "molotov", "molotov": "molotov", "incgrenade": "incendiaire", "taser": "Zeus",
          "world": "dégâts de chute", "planted_c4": "explosion de la bombe"}
NADE_SHORT = {"smoke": "Smoke", "flash": "Flash", "he": "HE", "molotov": "Molotov", "incendiary": "Molotov", "decoy": "Leurre"}

SYSTEM = """Tu es un coach Counter-Strike 2 qui explique le jeu à un joueur débutant, en français simple : phrases
courtes, termes techniques expliqués en quelques mots (pistol, eco, rotation, trade, lineup, retake, AWP).

Règles impératives :
1. Tu n'utilises QUE les faits fournis (une ligne JSON par fait). Chaque bloc cite dans "fact_ids" les identifiants des
   faits qu'il utilise. Aucun chiffre, horloge (ex. 1:45), lieu ou joueur qui ne soit dans un fait cité.
2. Les horloges sont celles du jeu (1:55 au début du round, puis le compte à rebours de la bombe une fois posée) :
   reprends-les telles qu'elles sont écrites dans les faits.
3. Comptages : « 7 rounds sur 9 », en reprenant exactement le k et le n d'un même fait. Fiabilité : "anecdotal" →
   « à confirmer », "indicative" → « tendance ». Pas de « toujours » ni de « jamais » sur un fait "anecdotal".
4. Explique le POURQUOI de chaque action importante quand les faits le permettent (gagner du temps, couper une
   arrivée, aider un coéquipier), sinon décris simplement. N'invente pas d'intention qui contredirait les faits.
5. Tu parles au joueur, pas de tes sources : n'écris jamais « les faits », « les données » ni « selon les faits ».
   Si une information manque, n'en parle pas. Donne la fiabilité (« tendance », « à confirmer ») une fois par bloc,
   pas à chaque ligne.
6. Réponds UNIQUEMENT avec un objet JSON : {"blocks": [{"title": "...", "text": "...", "fact_ids": ["..."]}]}.
   "text" peut contenir des listes Markdown simples (lignes commençant par « - »)."""

ROUND_PLAN = """Explique ce round à un débutant qui veut apprendre ce rôle. Blocs, dans cet ordre :
- "Ce qui se passe" : le round raconté étape par étape, avec l'horloge de chaque moment clé (5 à 8 lignes) ;
- "Ce qu'il fait bien" : 2 ou 3 choses à reproduire, chacune reliée à une étape ;
- "À retenir pour toi" : 2 conseils concrets pour jouer ce poste, tirés de ce round."""

ROUTINE_PLAN = """Écris un guide « Comment jouer ce poste comme lui » pour un débutant. Blocs, dans cet ordre :
- "Ton équipement" : son arme et ce qu'il achète d'habitude en round armé (protections, grenades) ;
- "Où te placer, et quand" : ses postes aux différents moments du round ;
- "Tes grenades" : lesquelles, vers où et à quel moment (horloge), avec leur fréquence ;
- "Quand ça tourne mal" : ses rotations et où il meurt le plus, avec ce qu'il faut en retenir ;
- "Ta check-list" : 3 à 5 points courts à appliquer dès ta prochaine partie."""


def _clock(t: float, plant_t: float | None = None) -> str:
    if plant_t is not None and t >= plant_t:
        left = max(0, round(BOMB_S - (t - plant_t)))
        return f"bombe {left // 60}:{left % 60:02d}"
    left = max(0, round(ROUND_S - t))
    return f"{left // 60}:{left % 60:02d}"


def _weapon(w: str | None) -> str:
    if not w:
        return "?"
    return WEAPON.get(w) or ("couteau" if "knife" in w or "bayonet" in w else w)


def _step_text(s: dict) -> str:
    where = pretty_place(s.get("place"))
    k = s["kind"]
    if k == "buy":
        return ("Achète : " + (", ".join(s.get("items") or []) or "rien (garde son équipement)")
                + (f" ; joue le round avec : {s['weapon']}" if s.get("weapon") else ""))
    if k == "place":
        return ("Se place à " if s.get("first") else "Se déplace vers ") + (where or "?")
    if k == "nade":
        to = pretty_place(s.get("target_place"))
        return f"Lance {NADE.get(s.get('nade') or '', 'une grenade')}" + (f" vers {to}" if to else "") + (f" depuis {where}" if where and where != to else "")
    if k == "kill":
        if s.get("teamkill"):
            return f"Tue son coéquipier {s.get('victim')}"
        return (f"{'Premier kill du round : ' if s.get('opening') else ''}élimine {s.get('victim')} ({_weapon(s.get('weapon'))})"
                + (" en headshot" if s.get("headshot") else "") + (f" depuis {where}" if where else ""))
    if k == "death":
        return f"Meurt contre {s.get('attacker') or '?'} ({_weapon(s.get('weapon'))})" + (f" à {where}" if where else "")
    if k == "plant":
        return f"Pose la bombe sur le site {s.get('site')}"
    if k == "defuse":
        return "Désamorce la bombe"
    if k == "end":
        return "Fin du round : " + ("gagné" if s.get("won") else "perdu") + (" (en vie)" if s.get("alive") else "")
    return k


def round_facts(story: dict, rnd: dict) -> list[dict]:
    side = rnd["side"]
    facts = [{"id": "round", "label": f"Round {rnd['number']} de {story['name']} ({story['team']}) contre {story['opponent']}, "
              f"en {'défense (CT)' if side == 'CT' else 'attaque (T)'}, achat {rnd.get('buy')}, "
              f"{'gagné' if rnd['won'] else 'perdu'}, {rnd['kills']} kill(s), {'mort' if rnd['died'] else 'en vie à la fin'}"
              + (f", poste {rnd['poste']}" if rnd.get("poste") else "")}]
    for i, s in enumerate(rnd["steps"]):
        mates, enemies = len(s.get("mates") or []), len(s.get("enemies") or [])
        situ = f" ({mates + (0 if s['kind'] == 'death' else 1)} de son équipe en vie contre {enemies})" if s["kind"] not in ("buy", "end") else ""
        util = [f"{NADE_SHORT.get(u['type'], u['type'])} adverse" for u in (s.get("enemy_utility") or [])][:3]
        facts.append({"id": f"step{i + 1}", "label": f"Étape {i + 1}, à {_clock(s['t'], rnd.get('plant_t'))} : {_step_text(s)}{situ}"
                      + (f" ; utilitaire ennemi actif : {', '.join(util)}" if util else "")})
    return facts


def routine_facts(r: dict) -> list[dict]:
    side = "défense (CT)" if r["side"] == "CT" else "attaque (T)"
    facts = [{"id": "routine", "label": f"Routine de {r['name']} en {side}, sur {r['rounds']} round(s) "
              f"{'armé(s)' if r['armed_only'] else ''} ({r['matches']} démo(s)) : rounds gagnés", **_stat(r["won"])}]
    for i, b in enumerate(r["buys"]):
        facts.append({"id": f"buy{i + 1}", "label": (f"Arme jouée : {b['buy']}" if b.get("kind") == "weapon" else f"Achète : {b['buy']}"), **_stat(b["count"])})
    for t in r["times"]:
        for j, p in enumerate(t["places"][:2]):
            facts.append({"id": f"at{t['t']}.{j + 1}", "label": f"À {t['clock']} (sur {t['alive']} rounds où il est en vie) : à {p['place']}",
                          **_stat(p["count"])})
    for i, n in enumerate(r["nades"]):
        facts.append({"id": f"nade{i + 1}", "label": f"{NADE_SHORT.get(n['type'], n['type'])} vers {n['place']}, vers {n['clock']} "
                      f"(entre {n['early_clock']} et {n['late_clock']})" + (f", depuis {n['from'][0]}" if n["from"] else ""), **_stat(n["count"])})
    for i, x in enumerate(r["rotations"]):
        facts.append({"id": f"rot{i + 1}", "label": f"Rotation vers {x['place']}", **_stat(x["count"])})
    for i, x in enumerate(r["deaths"]):
        facts.append({"id": f"death{i + 1}", "label": f"Meurt à {x['place']}", **_stat(x["count"])})
    return facts


def _stat(s: dict) -> dict:
    return {k: s[k] for k in ("k", "n", "pct", "lo", "hi", "level") if k in s}


async def write(kind: str, facts: list[dict], header: str, llm) -> dict:
    """Rédige et vérifie ; renvoie {blocks, checks, facts, tokens_in, tokens_out}."""
    by_id = {f["id"]: f for f in facts}
    usage = [0, 0]
    res = await report._section(llm, ROUND_PLAN if kind == "round" else ROUTINE_PLAN, facts, header, by_id, usage, system=SYSTEM)
    used = {x for b in res["blocks"] for x in b["fact_ids"]}
    return {"blocks": res["blocks"], "checks": res["checks"], "facts": {k: by_id[k] for k in used if k in by_id},
            "tokens_in": usage[0], "tokens_out": usage[1]}
