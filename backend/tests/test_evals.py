# backend/tests/test_evals.py
"""Évaluation du rapport IA : mutations, banc d'essai du contrôle, score, juge et campagne (modèles simulés)."""
import asyncio
import json

from app.ai import evals, report

FACTS = {
    "nuke.T.pistol": {"id": "nuke.T.pistol", "map": "de_nuke", "side": "T", "topic": "pistol", "label": "Nuke : pistols gagnés en attaque (T)",
                      "k": 2, "n": 3, "pct": 67, "lo": 28, "hi": 93, "level": "anecdotal", "examples": []},
    "nuke.CT.pistol": {"id": "nuke.CT.pistol", "map": "de_nuke", "side": "CT", "topic": "pistol", "label": "Nuke : pistols gagnés en défense (CT)",
                       "k": 1, "n": 3, "pct": 33, "lo": 7, "hi": 72, "level": "anecdotal", "examples": []},
    "nuke.CT.siteB.held": {"id": "nuke.CT.siteB.held", "map": "de_nuke", "side": "CT", "topic": "defense", "label": "Nuke : site B attaqué et tenu",
                           "k": 10, "n": 22, "pct": 45, "lo": 29, "hi": 63, "level": "solid", "examples": []},
    "nuke.player.FoG_G.opening": {"id": "nuke.player.FoG_G.opening", "map": "de_nuke", "side": None, "topic": "player",
                                  "label": "Nuke : FoG_G, premiers duels du round gagnés", "k": 12, "n": 21, "pct": 57, "lo": 39, "hi": 74, "level": "solid"},
    "nuke.player.shayn_.opening": {"id": "nuke.player.shayn_.opening", "map": "de_nuke", "side": None, "topic": "player",
                                   "label": "Nuke : shayn_, premiers duels du round gagnés", "k": 8, "n": 14, "pct": 57, "lo": 35, "hi": 77, "level": "indicative"},
}
GOOD = {"sections": [{"key": "map:de_nuke", "title": "Nuke", "map": "de_nuke", "blocks": [
    {"title": "Pistols", "text": "Pistol T gagné 2 fois sur 3 (67 %), à confirmer. Pistol CT : 1 sur 3, sur seulement 3 rounds.",
     "fact_ids": ["nuke.T.pistol", "nuke.CT.pistol"]},
    {"title": "Défense", "text": "Le site B est tenu 10 fois sur 22 (45 %) quand il est attaqué.", "fact_ids": ["nuke.CT.siteB.held"]},
    {"title": "Joueurs", "text": "FoG_G gagne 12 premiers duels sur 21, shayn_ 8 sur 14.",
     "fact_ids": ["nuke.player.FoG_G.opening", "nuke.player.shayn_.opening"]}]}]}


def test_mutations_and_checker_benchmark():
    muts = evals.mutations(GOOD, FACTS, per_kind=3)
    kinds = {m["kind"] for m in muts}
    assert {"chiffre décalé", "pourcentage faux", "fait inexistant", "nombre inventé", "mot absolu sur fait fragile",
            "site inversé", "joueurs inversés"} <= kinds
    assert all(m["content"] != GOOD for m in muts)
    b = evals.checker_benchmark([(GOOD, FACTS)])
    assert b["false_alarm_blocks"] == 0                       # le rapport intact ne déclenche rien
    for k in ("chiffre décalé", "pourcentage faux", "fait inexistant", "mot absolu sur fait fragile"):
        assert b["kinds"][k]["rate"] == 100, k                 # erreurs de chiffres : toutes attrapées
    # un nombre inventé passe s'il tombe par hasard sur une valeur des faits cités (limite connue, mesurée)
    assert b["kinds"]["nombre inventé"]["rate"] >= 50
    assert b["kinds"]["site inversé"]["rate"] == 0             # erreur de sens : invisible pour le contrôle (juge)
    assert b["code_detection"] >= 85


def test_score_report():
    s = evals.score_report(GOOD, FACTS)
    assert s["issues"] == 0 and s["numbers"] > 5
    cov = s["coverage"]["de_nuke"]
    assert cov["pistol T"] and cov["pistol CT"] and cov["défense des sites"] and cov["joueurs"] and not cov["premier gun round"]
    assert s["coverage_pct"] == 80 and s["anecdotal_blocks"] == 1 and s["hedge_missing"] == 0


def test_judge_and_campaign(monkeypatch):
    async def fake_judge(system, user):
        bad = "site A" in user and "Le site A est tenu" in user
        probs = [{"block": 0, "claim": "pistol", "verdict": "correct", "reason": "cohérent"}]  # ignoré
        if bad:
            probs.append({"block": 1, "claim": "site A", "verdict": "contredit", "reason": "les faits parlent de B"})
        return json.dumps({"problems": probs}), 300, 40
    swapped = json.loads(json.dumps(GOOD))
    swapped["sections"][0]["blocks"][1]["text"] = "Le site A est tenu 10 fois sur 22 (45 %) quand il est attaqué."
    assert asyncio.run(evals.judge(GOOD, FACTS, fake_judge))["count"] == 0
    j = asyncio.run(evals.judge(swapped, FACTS, fake_judge))
    assert j["count"] == 1 and j["problems"][0]["section"] == "map:de_nuke" and j["cost_usd"] is not None
    cal = asyncio.run(evals.judge_benchmark(GOOD, FACTS, fake_judge, n=2))
    assert cal["intact_alerts"] == 0 and cal["injected"] >= 1

    sheet = {"team": {"id": 1, "name": "Platzhalter"}, "matches": 3, "maps": ["de_nuke"], "facts": list(FACTS.values())}

    async def writer(system, user):
        sec = GOOD["sections"][0]
        return json.dumps({"blocks": sec["blocks"]}), 2000, 500
    monkeypatch.setattr(report, "llm_for", lambda key, model: writer)
    monkeypatch.setattr(evals, "judge_llm", lambda key: fake_judge)
    res = asyncio.run(evals.campaign([sheet], ["claude-haiku-5-5", "claude-sonnet-5-5"], "k"))
    assert [r["model"] for r in res["runs"]] == ["claude-haiku-5-5", "claude-sonnet-5-5"]
    r = res["runs"][0]
    assert r["issues"] == 0 and r["judge_problems"] == 0 and r["cost_usd"] < res["runs"][1]["cost_usd"]
