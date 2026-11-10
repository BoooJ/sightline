# backend/tests/test_scout_players.py
"""Scouting Tool joueurs : recherche (carte, rôle, rating, matchs), HLTV relatif, shortlists."""
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_player_search_and_shortlists(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    r = c.get("/api/scouting/players").json()
    assert len(r["players"]) == 10 and r["map"] is None
    assert abs(sum(p["relative"] for p in r["players"])) < 0.2  # centré sur la moyenne
    assert r["players"] == sorted(r["players"], key=lambda p: (-p["rating"], p["name"]))
    top = r["players"][0]
    assert c.get(f"/api/scouting/players?min_rating={top['rating']}").json()["players"][0]["steamid"] == top["steamid"]
    assert c.get("/api/scouting/players?min_matches=2").json()["players"] == []
    assert len(c.get(f"/api/scouting/players?q={top['name'][:3]}").json()["players"]) >= 1
    assert c.get("/api/scouting/players?map=nope").status_code == 400
    assert c.get("/api/scouting/players?role_t=nope").status_code == 400
    nuke = c.get("/api/scouting/players?map=de_nuke").json()
    assert len(nuke["players"]) == 10 and all("edge_roles" in p for p in nuke["players"])
    # filtre par rôle : sous-ensemble cohérent
    for role in ("lurk", "pack", "anchor"):
        sub = c.get(f"/api/scouting/players?map=de_nuke&role_t={role}").json()["players"] if role != "anchor" else c.get(f"/api/scouting/players?map=de_nuke&role_ct={role}").json()["players"]
        assert all((p["edge_roles"]["t"]["role"] if role != "anchor" else p["edge_roles"]["ct"]["role"]) == role for p in sub)
    # shortlists
    assert c.post("/api/shortlists", json={"name": " "}).status_code == 400
    s = c.post("/api/shortlists", json={"name": "AWP à recruter"}).json()
    s = c.post(f"/api/shortlists/{s['id']}/items", json={"steamid": top["steamid"], "name": top["name"], "note": "bon sur Nuke"}).json()
    assert s["count"] == 1 and s["items"][0]["note"] == "bon sur Nuke"
    s = c.post(f"/api/shortlists/{s['id']}/items", json={"steamid": top["steamid"], "note": "à revoir"}).json()  # doublon : note mise à jour
    assert s["count"] == 1 and s["items"][0]["note"] == "à revoir"
    assert c.get("/api/shortlists").json()[0]["count"] == 1
    s = c.delete(f"/api/shortlists/{s['id']}/items/{s['items'][0]['id']}").json()
    assert s["count"] == 0
    assert c.delete(f"/api/shortlists/{s['id']}").json()["ok"] and c.get("/api/shortlists").json() == []
