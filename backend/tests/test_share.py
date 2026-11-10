# backend/tests/test_share.py
"""Liens de partage publics : création, lecture sans session, limites au match, expiration."""
import io
import sqlite3

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}


def test_share_links(client):
    c, tmp = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    m = c.get("/api/matches").json()[0]
    detail = c.get(f"/api/matches/{m['id']}").json()
    r2, r3 = detail["rounds"][1], detail["rounds"][2]
    assert c.post("/api/share", json={"match_id": m["id"], "round_number": 999}).status_code == 400
    link = c.post("/api/share", json={"match_id": m["id"], "round_number": r2["number"], "tick": r2["start_tick"] + 64,
                                      "layers": [r3["id"], 999999]}).json()
    assert link["url"] == f"/s/{link['token']}" and link["layers"] == [r3["id"]] and link["tick"] == r2["start_tick"] + 64
    # un compte existe et personne n'est connecté → l'API exige une session, sauf les routes de partage
    assert c.post("/api/auth/setup", json=OWNER).status_code == 200
    c.post("/api/auth/logout")
    assert c.get("/api/matches").status_code == 401
    g = c.get(f"/api/share/{link['token']}")
    assert g.status_code == 200
    body = g.json()
    assert body["match"]["id"] == m["id"] and body["map"]["name"] == "de_nuke" and body["round_number"] == r2["number"]
    rp = c.get(f"/api/share/{link['token']}/replay/{r2['id']}")
    assert rp.status_code == 200 and rp.headers["content-type"] == "application/msgpack"
    assert c.get(f"/api/share/{link['token']}/replay/999999").status_code == 404
    assert c.get(f"/api/share/{link['token']}/audio").json() == []
    assert c.get("/api/share/nope").status_code == 404
    # la création reste protégée
    assert c.post("/api/share", json={"match_id": m["id"], "round_number": 1}).status_code == 401
    # expiration
    db = sqlite3.connect(str(tmp / "data" / "skybox.db"))
    db.execute("UPDATE share_links SET expires_at = '2000-01-01 00:00:00'")
    db.commit()
    db.close()
    assert c.get(f"/api/share/{link['token']}").status_code == 404
