# backend/tests/test_coach.py
"""L'IA comme coach (« Apprendre un rôle ») : faits d'un round et d'une routine, vérification, cache (modèle simulé)."""
import io
import json

from sqlalchemy import select

from app.ai import coach, report
from app.storage.models import MatchPlayer
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_round_facts_and_clock_check():
    story = {"name": "FoG_G", "team": "Platzhalter", "opponent": "MISTERYA", "map": "de_inferno"}
    rnd = {"number": 4, "side": "CT", "buy": "full", "won": True, "kills": 1, "died": False, "poste": "Banana", "plant_t": None,
           "steps": [{"kind": "buy", "t": 0, "items": ["M4A4", "Molotov"], "mates": [], "enemies": []},
                     {"kind": "nade", "t": 10.2, "nade": "molotov", "place": "Car", "target_place": "Banana", "mates": [1] * 4, "enemies": [1] * 5,
                      "enemy_utility": [{"type": "smoke"}]}]}
    f = coach.round_facts(story, rnd)
    assert f[0]["id"] == "round" and "Round 4" in f[0]["label"]
    assert f[2]["label"].startswith("Étape 2, à 1:45 : Lance un molotov vers Banana depuis Car (5 de son équipe en vie contre 5)")
    # une horloge reprise d'un fait cité passe le contrôle ; une horloge inventée non
    assert report.sentence_issues("À 1:45, il lance un molotov vers Banana.", [f[2]]) == []
    assert report.sentence_issues("À 1:38, il lance un molotov.", [f[2]])


def test_coach_endpoint_round_and_routine(client, monkeypatch):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    match = c.get("/api/matches").json()[0]["id"]
    with c.app.state.session_factory() as db:
        sid = db.scalar(select(MatchPlayer.steamid).where(MatchPlayer.match_id == match))
    st = c.get(f"/api/scouting/story?match={match}&steamid={sid}").json()
    rnd = st["rounds"][0]["number"]
    monkeypatch.delenv("SKYBOX_GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("SKYBOX_ANTHROPIC_API_KEY", "sk-ant-test")
    calls = []

    async def llm(system, user):
        calls.append(system)
        return json.dumps({"blocks": [{"title": "Ce qui se passe", "text": "Il joue son round.", "fact_ids": ["round", "step1"]}]}), 800, 120
    models = []
    monkeypatch.setattr(report, "llm_for", lambda key, model: (models.append(model), llm)[1])
    body = {"kind": "round", "match": match, "steamid": sid, "round": rnd}
    r = c.post("/api/scouting/coach", json=body).json()
    assert r["blocks"][0]["title"] == "Ce qui se passe" and r["cached"] is False and models == ["claude-haiku-5-5"]
    assert "coach Counter-Strike 2" in calls[0] and "round" in r["facts"]
    again = c.post("/api/scouting/coach", json=body).json()
    assert again["cached"] is True and len(calls) == 1          # gardé en cache : pas de second appel
    c.post("/api/scouting/coach", json={**body, "regenerate": True})
    assert len(calls) == 2                                     # mode ouvert (local) : régénération permise
    assert c.post("/api/scouting/coach", json={**body, "round": 999}).status_code == 404
    rt = c.post("/api/scouting/coach", json={"kind": "routine", "match": match, "steamid": sid, "side": st["rounds"][0]["side"]})
    assert rt.status_code in (200, 409)  # 409 : pas de round armé dans la démo de test
