# backend/tests/test_vetos.py
"""Vetos enregistrés : saisie, validation, statistiques Pick / Ban / Played dans les données du simulateur."""
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_veto_records(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    teams = {t["name"]: t["id"] for t in c.get("/api/scouting/teams").json()}
    a, b = teams["FaZe"], teams["3DMAX"]
    bad = {"team_a": a, "team_b": b, "format": "bo3", "steps": [{"team": "a", "action": "ban", "map": "nope"}]}
    assert c.post("/api/vetos", json=bad).status_code == 400
    assert c.post("/api/vetos", json={**bad, "steps": []}).status_code == 400
    assert c.post("/api/vetos", json={**bad, "team_b": a, "steps": [{"team": "a", "action": "ban", "map": "de_mirage"}]}).status_code == 400
    steps = [{"team": "a", "action": "ban", "map": "de_mirage"}, {"team": "b", "action": "ban", "map": "de_inferno"},
             {"team": "a", "action": "pick", "map": "de_nuke"}, {"team": "b", "action": "pick", "map": "de_ancient"},
             {"team": "a", "action": "ban", "map": "de_anubis"}, {"team": "b", "action": "ban", "map": "de_dust2"},
             {"team": "a", "action": "decider", "map": "de_cache"}]
    v = c.post("/api/vetos", json={"team_a": a, "team_b": b, "format": "bo3", "steps": steps, "played_on": "2026-10-01", "note": "ESEA S52"}).json()
    assert v["team_a"]["name"] == "FaZe" and len(v["steps"]) == 7 and v["played_on"] == "2026-10-01"
    # même veto vu du côté de 3DMAX (ils sont « b ») : un second enregistrement où 3DMAX est « a »
    c.post("/api/vetos", json={"team_a": b, "team_b": a, "format": "bo1", "steps": [{"team": "a", "action": "ban", "map": "de_nuke"}, {"team": "b", "action": "ban", "map": "de_mirage"}, {"team": "a", "action": "decider", "map": "de_inferno"}]})
    assert len(c.get("/api/vetos").json()) == 2 and len(c.get(f"/api/vetos?team={a}").json()) == 2
    d = c.get(f"/api/scouting/veto?team_a={a}&team_b={b}&maps=de_nuke,de_mirage,de_inferno").json()
    assert d["vetos"] == {"a": 2, "b": 2}
    nuke = next(m for m in d["maps"] if m["map"] == "de_nuke")
    assert nuke["a"]["pick"] == 1 and nuke["a"]["pick_pct"] == 50 and nuke["b"]["ban"] == 1 and nuke["a"]["played"] == 1
    mirage = next(m for m in d["maps"] if m["map"] == "de_mirage")
    assert mirage["a"]["ban"] == 2 and mirage["a"]["ban_pct"] == 100 and mirage["a"]["played_pct"] == 0
    assert c.delete(f"/api/vetos/{v['id']}").json()["ok"] and len(c.get("/api/vetos").json()) == 1
