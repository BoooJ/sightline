# backend/tests/test_report.py
"""Rapport de scouting rédigé par l'IA : contrôle des nombres, seconde passe, retrait des phrases fautives, API.
Le modèle est simulé : aucun appel réseau."""
import asyncio
import io
import json
import time

from app.ai import report
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

F = {"id": "nuke.T.pistol", "label": "Nuke : pistols gagnés en attaque (T)", "k": 7, "n": 9, "pct": 78, "lo": 50, "hi": 92,
     "level": "indicative", "examples": ["R13 contre 3Nation, gagné"], "map": "de_nuke", "side": "T", "topic": "pistol"}
A = {**F, "id": "nuke.T.after", "k": 1, "n": 1, "pct": 100, "lo": 27, "hi": 100, "level": "anecdotal", "examples": []}


def test_sentence_checks():
    assert report.sentence_issues("Ils gagnent 7 fois sur 9 le pistol T (78 %).", [F]) == []
    assert report.sentence_issues("Environ 79 % de réussite.", [F]) == []          # pourcentage à ±1
    assert report.sentence_issues("Revoir le round 13.", [F]) == []                # chiffre d'un exemple cité
    assert report.sentence_issues("Les 3 actions : jouer à 2 sur B.", [F]) == []    # petits nombres courants
    assert "8" in report.sentence_issues("Ils gagnent 8 fois sur 9.", [F])[0]
    assert report.sentence_issues("Ils forcent toujours.", [A])                    # mot absolu sur un fait à confirmer
    assert report.sentence_issues("Ils gagnent 7 fois sur 9.", []) != []           # sans fait cité, pas de chiffre


def test_drop_bad_sentences():
    blocks = [{"title": "x", "text": "Bon : 7 fois sur 9. Faux : 42 fois.\n- ligne 78 %", "fact_ids": ["nuke.T.pistol"]}]
    probs = report.check_blocks(blocks, {F["id"]: F})
    assert len(probs) == 1 and probs[0]["sentence"] == "Faux : 42 fois."
    assert report.drop_bad_sentences(blocks, probs) == 1
    assert "42" not in blocks[0]["text"] and "7 fois sur 9" in blocks[0]["text"] and "78 %" in blocks[0]["text"]


SHEET = {"team": {"id": 1, "name": "Platzhalter"}, "matches": 3, "maps": ["de_nuke"], "facts": [F, A]}


def fake_llm(answers):
    calls = []

    async def llm(system, user):
        calls.append(user)
        return answers[min(len(calls) - 1, len(answers) - 1)](user), 1000, 200
    llm.calls = calls
    return llm


def _blocks(text):
    return json.dumps({"blocks": [{"title": "Pistols", "text": text, "fact_ids": ["nuke.T.pistol"]}]})


def test_generate_retries_then_passes():
    llm = fake_llm([lambda u: "voici : " + _blocks("Pistol T gagné 8 fois sur 9."),   # faux
                    lambda u: _blocks("Pistol T gagné 7 fois sur 9 (78 %), une tendance.")])
    res = asyncio.run(report.generate(SHEET, llm))
    assert [s["key"] for s in res["sections"]] == ["summary", "map:de_nuke"]
    assert res["checks"]["first_pass_issues"] >= 1 and res["checks"]["removed_sentences"] == 0
    assert all("7 fois sur 9" in s["blocks"][0]["text"] for s in res["sections"])
    assert res["tokens_in"] > 0 and "nuke.T.pistol" in res["facts"]


def test_generate_drops_persistent_errors():
    llm = fake_llm([lambda u: _blocks("Pistol T gagné 7 fois sur 9. Ils ont 55 % ailleurs.")])
    res = asyncio.run(report.generate(SHEET, llm))
    assert res["checks"]["removed_sentences"] == 2   # une phrase fausse par section, 2 sections
    assert all("55" not in s["blocks"][0]["text"] for s in res["sections"])


def test_cost():
    assert report.cost_of("claude-sonnet-5-5", 1_000_000, 100_000) == 3.0
    assert report.cost_of("modele-inconnu", 1, 1) is None


def test_facts_and_report_api(client, monkeypatch):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    team = c.get("/api/scouting/teams").json()[0]["id"]
    sheet = c.get(f"/api/scouting/teams/{team}/facts").json()
    ids = [f["id"] for f in sheet["facts"]]
    assert len(ids) == len(set(ids)) and "team.record" in ids and any(i.startswith("nuke.T.pistol") for i in ids)
    assert c.get(f"/api/scouting/teams/{team}/report").json() is None
    monkeypatch.delenv("SKYBOX_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("SKYBOX_GEMINI_API_KEY", raising=False)
    assert c.post(f"/api/scouting/teams/{team}/report").status_code == 409  # pas de clé
    monkeypatch.setenv("SKYBOX_ANTHROPIC_API_KEY", "sk-ant-test")
    pid = next(i for i in ids if i.startswith("nuke.T.pistol"))
    fact = next(f for f in sheet["facts"] if f["id"] == pid)
    good = json.dumps({"blocks": [{"title": "Pistols", "text": f"Pistol T : {fact['k']} sur {fact['n']}.", "fact_ids": [pid]}]})

    async def llm(system, user):
        return good, 500, 100
    monkeypatch.setattr(report, "llm_for", lambda key, model: llm)
    from app.ai import evals

    async def fake_judge(system, user):
        return json.dumps({"problems": [{"block": 0, "claim": "Pistol T", "verdict": "contredit", "reason": "test"},
                                        {"block": 0, "claim": "ok", "verdict": "correct", "reason": "juste"}]}), 100, 20
    monkeypatch.setattr(evals, "judge_llm", lambda key: fake_judge)
    assert c.post(f"/api/scouting/teams/{team}/report?model=inconnu").status_code == 400
    r = c.post(f"/api/scouting/teams/{team}/report?model=claude-haiku-5-5").json()
    assert r["status"] == "running"
    t = time.time()
    while time.time() - t < 20 and (r := c.get(f"/api/scouting/teams/{team}/report").json())["status"] == "running":
        time.sleep(0.2)
    assert r["status"] == "done", r.get("error")
    assert [s["key"] for s in r["content"]["sections"]][0] == "summary"
    assert r["checks"]["removed_sentences"] == 0 and r["cost_usd"] is not None and r["model"] == "claude-haiku-5-5"
    assert r["checks"]["judge_alerts"] == len(r["content"]["sections"])   # une remarque « contredit » par section
    alerts = r["content"]["sections"][0]["blocks"][0]["alerts"]
    assert alerts == [{"claim": "Pistol T", "verdict": "contredit", "reason": "test"}]


def test_unreadable_section_does_not_fail_report():
    llm = fake_llm([lambda u: "pas du JSON"])
    res = asyncio.run(report.generate(SHEET, llm))
    assert all(s["blocks"][0]["text"].startswith("Cette partie n'a pas pu") for s in res["sections"])
    assert all(c.get("failed") for c in res["checks"]["sections"].values())


def test_count_pairs_must_match_one_fact():
    play = {**F, "id": "nuke.T.pistol.play1", "k": 2, "n": 3, "pct": 67, "level": "anecdotal", "examples": []}
    assert report.sentence_issues("Rush sur A 2 fois sur 3.", [play]) == []
    iss = report.sentence_issues("Rush sur A 3 fois sur 3.", [play])   # chaque nombre existe, pas le couple
    assert any("3 sur 3" in i for i in iss)
    assert report.sentence_issues("Sur seulement 3 rounds : 7 sur 9.", [F, play]) == []


def test_percentages_must_match_and_add_up():
    assert report.sentence_issues("Gagnés 7 fois sur 9 (78 %).", [F]) == []
    assert report.sentence_issues("Gagnés 7 fois sur 9 (92 %).", [F])              # 92 est une borne, mais 7/9 ≠ 92 %
    assert any("%" in i for i in report.sentence_issues("Environ 9 % de réussite.", [F]))  # 9 existe, pas 9 %
    assert report.sentence_issues("Entre 50 et 92 % selon la fourchette.", [F]) == []
