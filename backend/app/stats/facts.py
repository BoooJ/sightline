# backend/app/stats/facts.py
"""Fiche de faits d'une équipe : tous les chiffres du scouting, calculés en code, chacun avec un identifiant stable.

C'est la seule source de chiffres du rapport écrit par l'IA (reports/Rapport scouting CS2 par LLM.md) : le modèle cite
les identifiants, et le code vérifie que chaque nombre de son texte apparaît dans les faits cités. Un fait :
{id, map, side, topic, label, k, n, pct, lo, hi, level, value, examples}. `k`/`n` : comptage (« 7 sur 9 ») ; `value` :
valeur simple (temps moyen, rating) ; `examples` : rounds à revoir (« R4 contre 3Nation, gagné »)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.registry import MapMeta
from app.stats.brief import stat, team_brief
from app.stats.scouting import team_report
from app.storage.models import FaceitTeam, Match

MAX_EXAMPLES = 3


def _short(map_name: str) -> str:
    return map_name.removeprefix("de_")


def team_facts(session: Session, maps: dict[str, MapMeta], team_id: int, brief_of=None) -> dict | None:
    """`brief_of(map)` : brief d'une carte (permet de passer par le cache de l'API)."""
    rep = team_report(session, team_id)
    if rep is None:
        return None
    brief_of = brief_of or (lambda m: team_brief(session, maps, team_id, m))
    opponents = {m.id: (m.team_b.name if m.team_a_id == team_id else m.team_a.name)
                 for m in session.scalars(select(Match).where((Match.team_a_id == team_id) | (Match.team_b_id == team_id)))}
    facts: list[dict] = []

    def add(fid: str, label: str, s: dict | None = None, *, map_name: str | None = None, side: str | None = None,
            topic: str = "", value=None, b: dict | None = None) -> None:
        f = {"id": fid, "map": map_name, "side": side, "topic": topic, "label": label}
        if s is not None:
            f.update({k: s[k] for k in ("k", "n", "pct", "lo", "hi", "level")})
            if b is not None and s.get("rounds"):
                ex = []
                for rid in s["rounds"][:MAX_EXAMPLES]:
                    mid, num, won = b["round_index"].get(rid) or b["round_index"].get(str(rid)) or (None, None, None)
                    if mid is not None:
                        ex.append(f"R{num} contre {opponents.get(mid, '?')}, {'gagné' if won else 'perdu'}")
                f["examples"] = ex
        if value is not None:
            f["value"] = value
        facts.append(f)

    add("team.record", f"Matchs analysés de {rep['team']['name']} : gagnés", {"k": rep["wins"], "n": rep["matches"],
        "pct": round(100 * rep["wins"] / rep["matches"]) if rep["matches"] else None, "lo": 0, "hi": 100,
        "level": "solid" if rep["matches"] >= 15 else "indicative" if rep["matches"] >= 6 else "anecdotal"}, topic="team")
    ft = session.scalar(select(FaceitTeam).where(FaceitTeam.name == rep["team"]["name"]))
    for m in rep["maps"]:
        add(f"pool.{_short(m['map'])}", f"{m['display_name']} : matchs gagnés", {"k": m["won"], "n": m["played"],
            "pct": round(m["win_pct"]), "lo": 0, "hi": 100,
            "level": "solid" if m["played"] >= 8 else "indicative" if m["played"] >= 3 else "anecdotal"},
            map_name=m["map"], topic="pool")

    for m in rep["maps"]:
        mp, b = m["map"], brief_of(m["map"])
        p = _short(mp)
        name = b["display_name"]
        for side in ("T", "CT"):
            word = "en attaque (T)" if side == "T" else "en défense (CT)"
            add(f"{p}.{side}.rounds", f"{name} : rounds gagnés {word}", b["sides"][side], map_name=mp, side=side, topic="side")
            pi = b["pistols"][side]
            add(f"{p}.{side}.pistol", f"{name} : pistols gagnés {word}", pi["result"], map_name=mp, side=side, topic="pistol", b=b)
            for i, play in enumerate(pi["plays"]):
                add(f"{p}.{side}.pistol.play{i + 1}", f"{name} : au pistol {word}, « {play['label']} »", play["count"],
                    map_name=mp, side=side, topic="pistol", b=b)
                add(f"{p}.{side}.pistol.play{i + 1}.won", f"{name} : pistols « {play['label']} » gagnés {word}",
                    stat(play["won"], play["count"]["k"]), map_name=mp, side=side, topic="pistol")
            if pi["after_won"]:
                add(f"{p}.{side}.after_pistol_won", f"{name} : après un pistol gagné {word}, round suivant gagné",
                    pi["after_won"]["won"], map_name=mp, side=side, topic="economy", b=b)
            if pi["after_lost"]:
                add(f"{p}.{side}.after_pistol_lost", f"{name} : après un pistol perdu {word}, achat quand même (force)",
                    pi["after_lost"]["bought"], map_name=mp, side=side, topic="economy", b=b)
                add(f"{p}.{side}.after_pistol_lost_won", f"{name} : après un pistol perdu {word}, round suivant gagné",
                    pi["after_lost"]["won"], map_name=mp, side=side, topic="economy", b=b)
            for key, how in (("after_lost_planted", "avec la bombe posée (+800 $ par joueur)"), ("after_lost_unplanted", "sans poser la bombe")):
                if pi.get(key):
                    add(f"{p}.{side}.{key}", f"{name} : après un pistol T perdu {how}, achat au round suivant",
                        pi[key]["bought"], map_name=mp, side=side, topic="economy", b=b)
            add(f"{p}.{side}.first_gun", f"{name} : premier round avec armes complètes gagné {word}",
                b["first_gun"][side]["result"], map_name=mp, side=side, topic="economy", b=b)
        for st in b["t_styles"]:
            site = max(st["sites"], key=st["sites"].get) if st["sites"] else None
            where = f", surtout vers {site}" if site and site != "none" else ""
            add(f"{p}.T.style.{st['key']}", f"{name} : en attaque, « {st['label']} »{where}", st["count"], map_name=mp,
                side="T", topic="attack", b=b)
            add(f"{p}.T.style.{st['key']}.won", f"{name} : rounds « {st['label']} » gagnés", st["won"], map_name=mp,
                side="T", topic="attack")
        if b["avg_contact_s"] is not None:
            add(f"{p}.T.contact_s", f"{name} : premier contact moyen en attaque (secondes après le début du round)",
                map_name=mp, side="T", topic="attack", value=round(b["avg_contact_s"]))
        for i, s in enumerate(b["ct_setups"][:3]):
            add(f"{p}.CT.setup{i + 1}", f"{name} : placement CT à 20 s « {s['setup']} » (joueurs par site)", s["count"],
                map_name=mp, side="CT", topic="defense", b=b)
            add(f"{p}.CT.setup{i + 1}.won", f"{name} : rounds gagnés avec le placement « {s['setup']} »", s["won"],
                map_name=mp, side="CT", topic="defense")
        for site, d in b["sites"].items():
            add(f"{p}.CT.site{site}.held", f"{name} : site {site} attaqué et tenu (round gagné sans pose)", d["held"],
                map_name=mp, side="CT", topic="defense")
            add(f"{p}.CT.site{site}.retakes", f"{name} : retakes du site {site} gagnés après une pose", d["retakes"],
                map_name=mp, side="CT", topic="defense")
        for side in ("T", "CT"):
            for i, u in enumerate(b["utility"][side][:5]):
                add(f"{p}.{side}.util{i + 1}", f"{name} : {u['type']} vers {u['place']} ({', '.join(u['players'])})",
                    u["count"], map_name=mp, side=side, topic="utility", b=b)
        for pl in b["players"]:
            key = f"{p}.player.{pl['name']}"
            for side in ("CT", "T"):
                if pl["spots"][side]:
                    sp = pl["spots"][side][0]
                    add(f"{key}.{side}.spot", f"{name} : {pl['name']} à 20 s en {side}, surtout à {sp['place']}", sp["count"],
                        map_name=mp, side=side, topic="player")
            if pl["opening"]["n"]:
                add(f"{key}.opening", f"{name} : {pl['name']}, premiers duels du round gagnés", pl["opening"],
                    map_name=mp, topic="player", b=b)
            if pl["awper"]:
                add(f"{key}.awp", f"{name} : {pl['name']} est l'AWPer (kills à l'AWP)", map_name=mp, topic="player",
                    value=pl["awp_kills"])
    for pl in rep["players"]:
        add(f"player.{pl['name']}.rating", f"{pl['name']} : rating sur les démos analysées (1,00 = moyenne)",
            topic="player", value=round(pl["rating"], 2))
    return {"team": {"id": rep["team"]["id"], "name": rep["team"]["name"], "faceit_team_id": ft.team_id if ft else None},
            "matches": rep["matches"], "maps": [m["map"] for m in rep["maps"]], "facts": facts}
