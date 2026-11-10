# backend/tests/test_team_stats.py
"""Stats d'équipe : blocs par carte et par camp, joueurs du roster, 4v5 / 5v4, référence d'équipe."""
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def _seed(c):
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    return {t["name"]: t["id"] for t in c.get("/api/teams").json()}


def test_team_stats(client):
    c, _ = client
    teams = _seed(c)
    s = c.get(f"/api/teams/{teams['FaZe']}/stats").json()
    assert s["team"]["name"] == "FaZe" and s["matches"] == 1 and s["won"] == 0
    o = s["overall"]
    assert o["rounds"] == 23 and o["won"] == 10 and o["win_pct"] == 43.5
    assert o["v5_rounds"] + o["v4_rounds"] == o["opening_won"] + o["opening_lost"] <= 23
    assert o["pistols"] == 2 and 0 <= o["trade_pct"] <= 100 and o["udr"] >= 0 and o["far"] >= 0
    nuke = s["maps"][0]
    assert nuke["map"] == "de_nuke" and set(nuke["sides"]) == {"CT", "T"}
    assert nuke["sides"]["CT"]["rounds"] + nuke["sides"]["T"]["rounds"] == 23
    assert nuke["sides"]["CT"]["won"] + nuke["sides"]["T"]["won"] == 10
    # cohérence avec le rapport de scouting
    rep = c.get(f"/api/scouting/teams/{teams['FaZe']}").json()
    assert rep["maps"][0]["ct"]["won"] == nuke["sides"]["CT"]["won"] and rep["maps"][0]["t"]["rounds"] == nuke["sides"]["T"]["rounds"]
    assert len(s["players"]) == 5 and s["players"][0]["rating"] >= s["players"][-1]["rating"]
    p = s["players"][0]
    assert set(p["opening"]) >= {"attempts", "kills", "deaths", "kd", "traded_pct", "ktd"} and "1v1" in p["clutches"]
    assert sum(x["opening"]["kills"] for x in s["players"]) == o["opening_won"]
    assert sum(x["opening"]["deaths"] for x in s["players"]) == o["opening_lost"]
    # filtres de la barre
    ct = c.get(f"/api/teams/{teams['FaZe']}/stats?side=CT").json()
    assert ct["overall"]["rounds"] == nuke["sides"]["CT"]["rounds"] and list(ct["maps"][0]["sides"]) == ["CT"]
    assert c.get(f"/api/teams/{teams['FaZe']}/stats?map=de_dust2").json()["maps"] == []
    assert c.get("/api/teams/999/stats").status_code == 404
    assert c.get(f"/api/teams/{teams['FaZe']}/stats?side=X").status_code == 400


def test_team_positions_and_baseline(client):
    c, _ = client
    teams = _seed(c)
    pos = c.get(f"/api/teams/{teams['3DMAX']}/positions").json()
    assert len(pos) == 5 and all(set(p) == {"steamid", "name", "T", "CT", "maps"} for p in pos)
    b = c.get(f"/api/compare?mode=teams&target=team&cmp_teams={teams['FaZe']},{teams['3DMAX']}&cmp_months=12").json()
    assert b["kind"] == "team" and b["n_teams"] == 2 and b["rounds"] == 46 and b["won"] == 23 and b["win_pct"] == 50.0
    empty = c.get("/api/compare?mode=teams&target=team").json()
    assert empty["rounds"] == 0
