# backend/tests/test_notes.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}


def _import(c):
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    return c.get("/api/matches").json()[0]


def _strat(c, name="Split B"):
    return c.post("/api/strats", json={"name": name, "map": "de_nuke", "side": "T", "type": "execute"}).json()


def test_notes_crud_and_filters(client):
    c, _ = client
    m = _import(c)
    s = _strat(c)
    a = c.post("/api/notes", json={"map": "de_nuke", "side": "T", "body": "  rush outside au pistol  ", "match_id": m["id"],
                                   "team_id": m["team_a"]["id"], "strat_id": s["id"]})
    assert a.status_code == 200
    n = a.json()
    assert n["body"] == "rush outside au pistol" and n["side"] == "T" and n["shared"] is False and n["mine"] is True
    assert n["match"] == {"id": m["id"], "title": f"{m['team_a']['name']} vs {m['team_b']['name']}", "date": m["date"]}
    assert n["team"] == {"id": m["team_a"]["id"], "name": m["team_a"]["name"]} and n["strat"] == {"id": s["id"], "name": "Split B"}
    both = c.post("/api/notes", json={"map": "de_nuke", "body": "smoke heaven trop tard"}).json()
    assert both["side"] is None and both["match"] is None and both["team"] is None and both["strat"] is None
    c.post("/api/notes", json={"map": "de_dust2", "body": "autre carte"})

    assert {x["id"] for x in c.get("/api/notes?map=de_nuke&side=T").json()} == {n["id"], both["id"]}  # « les deux » compte pour T
    assert [x["id"] for x in c.get("/api/notes?map=de_nuke&side=CT").json()] == [both["id"]]
    assert [x["id"] for x in c.get(f"/api/notes?match={m['id']}").json()] == [n["id"]]
    assert [x["id"] for x in c.get(f"/api/notes?team={m['team_a']['id']}").json()] == [n["id"]]
    assert [x["id"] for x in c.get(f"/api/notes?strat={s['id']}").json()] == [n["id"]]
    assert len(c.get("/api/notes").json()) == 3
    assert c.get(f"/api/notes/{n['id']}").json()["body"] == "rush outside au pistol"

    up = c.patch(f"/api/notes/{n['id']}", json={"body": "rush outside, molo sur mini", "side": None, "strat_id": None, "shared": True}).json()
    assert up["body"] == "rush outside, molo sur mini" and up["side"] is None and up["strat"] is None and up["shared"] is True
    assert up["match"]["id"] == m["id"]  # champs absents : inchangés
    assert c.get("/api/notes").json()[0]["id"] == n["id"]  # la dernière modifiée d'abord

    assert c.delete(f"/api/notes/{n['id']}").json() == {"ok": True}
    assert c.get(f"/api/notes/{n['id']}").status_code == 404


def test_notes_validation(client):
    c, _ = client
    ok = {"map": "de_nuke", "body": "x"}
    assert c.post("/api/notes", json={**ok, "map": "de_inconnue"}).status_code == 400
    assert c.post("/api/notes", json={**ok, "body": "   "}).status_code == 400
    assert c.post("/api/notes", json={**ok, "body": "a" * 2001}).status_code == 400
    assert c.post("/api/notes", json={**ok, "body": "a" * 2000}).status_code == 200
    assert c.post("/api/notes", json={**ok, "side": "X"}).status_code == 400
    assert c.post("/api/notes", json={**ok, "match_id": 999}).status_code == 400
    assert c.post("/api/notes", json={**ok, "team_id": 999}).status_code == 400
    assert c.post("/api/notes", json={**ok, "strat_id": 999}).status_code == 400
    nid = c.post("/api/notes", json=ok).json()["id"]
    assert c.patch(f"/api/notes/{nid}", json={"body": ""}).status_code == 400
    assert c.patch(f"/api/notes/{nid}", json={"map": "de_inconnue"}).status_code == 400
    assert c.patch("/api/notes/9999", json={"body": "y"}).status_code == 404


def test_notes_privacy_and_rights(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    mine = c.post("/api/notes", json={"map": "de_nuke", "body": "perso"}).json()
    team = c.post("/api/notes", json={"map": "de_nuke", "body": "équipe", "shared": True}).json()
    assert team["author"] == "Coach" and team["author_id"] is not None
    inv = c.post("/api/team/invites", json={"role": "member"}).json()
    c.post("/api/auth/logout")
    c.post("/api/auth/register", json={"token": inv["token"], "username": "joueur2", "display_name": "J2", "password": "motdepasse2"})

    seen = c.get("/api/notes").json()
    assert [x["body"] for x in seen] == ["équipe"] and seen[0]["mine"] is False
    assert c.get(f"/api/notes/{mine['id']}").status_code == 404
    assert c.patch(f"/api/notes/{mine['id']}", json={"body": "x"}).status_code == 404
    assert c.patch(f"/api/notes/{team['id']}", json={"body": "x"}).status_code == 403
    assert c.delete(f"/api/notes/{team['id']}").status_code == 403
    own = c.post("/api/notes", json={"map": "de_nuke", "body": "de J2", "shared": True}).json()
    assert own["mine"] is True

    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "coach", "password": "motdepasse1"})
    assert c.patch(f"/api/notes/{own['id']}", json={"body": "x"}).status_code == 403  # même un admin ne réécrit pas
    assert c.delete(f"/api/notes/{own['id']}").json() == {"ok": True}  # mais il peut retirer une note d'équipe
    assert {x["body"] for x in c.get("/api/notes").json()} == {"perso", "équipe"}


def test_note_survives_strat_deletion(client):
    c, _ = client
    s = _strat(c)
    n = c.post("/api/notes", json={"map": "de_nuke", "side": "T", "body": "garder la flash", "strat_id": s["id"]}).json()
    assert c.delete(f"/api/strats/{s['id']}").json()["ok"]
    after = c.get(f"/api/notes/{n['id']}").json()
    assert after["strat"] is None and after["map"] == "de_nuke" and after["side"] == "T"


def test_notes_bearer_write(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    c.post("/api/auth/logout")
    c.cookies.clear()
    tok = c.post("/api/auth/token", json={"username": "coach", "password": "motdepasse1"}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert c.post("/api/notes", json={"map": "de_nuke", "body": "depuis l'APK"}).status_code == 401
    r = c.post("/api/notes", json={"map": "de_nuke", "body": "depuis l'APK"}, headers=h)
    assert r.status_code == 200 and r.json()["author"] == "Coach"
    assert [x["body"] for x in c.get("/api/notes", headers=h).json()] == ["depuis l'APK"]
