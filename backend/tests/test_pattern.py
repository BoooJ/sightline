# backend/tests/test_pattern.py
"""Pattern Finder : motif + filtres de round, négation, tactiques incluses / exclues."""
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

HUGE = [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]]


def test_pattern_finder(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    teams = {t["name"]: t["id"] for t in c.get("/api/teams").json()}
    team = next(tid for tid in teams.values() if c.get(f"/api/playbook/{tid}?map=de_nuke&side=T").json()["total"] > 0)
    body = {"map": "de_nuke", "side": "T", "definition": {"conditions": [{"kind": "players_in_zone", "zone": HUGE, "min_players": 1}]}}
    r = c.post(f"/api/pattern-finder/{team}", json=body).json()
    assert r["total"] > 0 and len(r["matched"]) == r["total"] and r["ids"] == [x["round_id"] for x in r["matched"]]
    assert set(r["matched"][0]) >= {"round_id", "match_id", "number", "won", "buy", "opp_buy", "opponent", "at_s"}
    # négation : plus rien
    neg = c.post(f"/api/pattern-finder/{team}", json={**body, "filters": {"negate": True}}).json()
    assert neg["total"] == r["total"] and neg["matched"] == []
    # issue : partition ; achat : sous-ensemble
    won = c.post(f"/api/pattern-finder/{team}", json={**body, "filters": {"outcome": "won"}}).json()
    lost = c.post(f"/api/pattern-finder/{team}", json={**body, "filters": {"outcome": "lost"}}).json()
    assert won["total"] + lost["total"] == r["total"]
    pistol = c.post(f"/api/pattern-finder/{team}", json={**body, "filters": {"buy": ["pistol"]}}).json()
    assert pistol["total"] <= r["total"] and all(x["buy"] == "pistol" for x in pistol["matched"])
    # joueurs vivants minimum impossible (6) → rien ; sans motif → tous les rounds observables
    assert c.post(f"/api/pattern-finder/{team}", json={**body, "filters": {"min_alive": 6}}).json()["matched"] == []
    assert c.post(f"/api/pattern-finder/{team}", json={"map": "de_nuke", "side": "T"}).json()["total"] == r["total"]
    # tactique incluse / exclue
    t = c.post("/api/tactics", json={"name": "Partout", "map": "de_nuke", "side": "T", "definition": body["definition"]}).json()
    inc = c.post(f"/api/pattern-finder/{team}", json={"map": "de_nuke", "side": "T", "filters": {"include_tactics": [t["id"]]}}).json()
    exc = c.post(f"/api/pattern-finder/{team}", json={"map": "de_nuke", "side": "T", "filters": {"exclude_tactics": [t["id"]]}}).json()
    assert len(inc["matched"]) == r["total"] and exc["matched"] == []
    assert c.post(f"/api/pattern-finder/{team}", json={"map": "nope", "side": "T"}).status_code == 400
    assert c.post(f"/api/pattern-finder/{team}", json={"map": "de_nuke", "side": "T", "definition": {"conditions": [{"kind": "nope"}]}}).status_code == 400
