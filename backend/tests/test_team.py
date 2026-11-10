# backend/tests/test_team.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}


def test_open_mode_then_setup_locks_api(client):
    c, _ = client
    assert c.get("/api/auth/me").json() == {"user": None, "setup_required": True, "setup_code_required": False}
    assert c.get("/api/matches").status_code == 200  # mode ouvert
    assert c.post("/api/auth/setup", json={**OWNER, "password": "court"}).status_code == 400
    r = c.post("/api/auth/setup", json=OWNER)
    assert r.status_code == 200 and r.json()["user"]["role"] == "owner"
    assert c.get("/api/auth/me").json()["user"]["username"] == "coach"
    assert c.post("/api/auth/setup", json={**OWNER, "username": "autre"}).status_code == 409
    c.post("/api/auth/logout")
    assert c.get("/api/matches").status_code == 401
    assert c.get("/api/health").status_code == 200
    assert c.post("/api/auth/login", json={"username": "coach", "password": "faux"}).status_code == 401
    assert c.post("/api/auth/login", json={"username": "COACH", "password": "motdepasse1"}).status_code == 200
    assert c.get("/api/matches").status_code == 200


def test_invites_roles_and_comments(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    c.post("/api/auth/setup", json=OWNER)
    inv = c.post("/api/team/invites", json={"role": "member"}).json()
    assert c.get("/api/team/invites").json()[0]["id"] == inv["id"]
    c.post("/api/auth/logout")
    assert c.get(f"/api/auth/invite/{inv['token']}").json() == {"valid": True, "role": "member"}
    r = c.post("/api/auth/register", json={"token": inv["token"], "username": "joueur1", "display_name": "Joueur 1",
                                           "password": "motdepasse2"})
    assert r.status_code == 200 and r.json()["user"]["role"] == "member"
    assert c.get(f"/api/auth/invite/{inv['token']}").json()["valid"] is False  # usage unique
    # un membre ne gère pas l'équipe
    assert c.post("/api/team/invites", json={}).status_code == 403
    members = c.get("/api/team/members").json()
    assert [m["role"] for m in members] == ["owner", "member"]
    # commentaires
    mid = c.get("/api/matches").json()[0]["id"]
    com = c.post(f"/api/matches/{mid}/comments", json={"round_number": 3, "tick": 5000, "body": "bon timing"}).json()
    assert com["author"] == "Joueur 1"
    assert c.post(f"/api/matches/{mid}/comments", json={"round_number": 99, "body": "x"}).status_code == 400
    assert c.post(f"/api/matches/{mid}/comments", json={"body": "  "}).status_code == 400
    c.post(f"/api/matches/{mid}/comments", json={"body": "général"})
    lst = c.get(f"/api/matches/{mid}/comments").json()
    assert [x["body"] for x in lst] == ["général", "bon timing"]
    # le propriétaire peut supprimer, promouvoir, mais pas se rétrograder s'il est seul
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"username": "coach", "password": "motdepasse1"})
    owner_id = members[0]["id"]
    assert c.patch(f"/api/team/members/{owner_id}", json={"role": "member"}).status_code == 409
    assert c.patch(f"/api/team/members/{members[1]['id']}", json={"role": "admin"}).json()["role"] == "admin"
    assert c.delete(f"/api/comments/{com['id']}").json()["ok"]
    assert c.patch("/api/auth/me", json={"current_password": "faux", "new_password": "nouveaumdp1"}).status_code == 403
    assert c.patch("/api/auth/me", json={"current_password": "motdepasse1", "new_password": "nouveaumdp1",
                                         "display_name": "Le coach"}).json()["display_name"] == "Le coach"
    assert c.delete(f"/api/team/members/{members[1]['id']}").json()["ok"]
    assert len(c.get("/api/team/members").json()) == 1



def test_private_comments_and_shapes(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    c.post("/api/auth/setup", json=OWNER)
    mid = c.get("/api/matches").json()[0]["id"]
    shape = {"id": "s1", "tool": "arrow", "color": "#fff", "width": 3, "level": "upper", "points": [[1, 2], [3, 4]]}
    pub = c.post(f"/api/matches/{mid}/comments", json={"round_number": 2, "tick": 100, "body": "équipe", "shapes": [shape]}).json()
    assert pub["shapes"][0]["tool"] == "arrow" and pub["private"] is False
    c.post(f"/api/matches/{mid}/comments", json={"round_number": 2, "body": "perso", "private": True})
    assert c.post(f"/api/matches/{mid}/comments", json={"body": "x", "shapes": [{"tool": "laser", "points": [[1, 1]]}]}).status_code == 400
    assert {x["body"] for x in c.get(f"/api/matches/{mid}/comments").json()} == {"équipe", "perso"}
    inv = c.post("/api/team/invites", json={"role": "member"}).json()
    c.post("/api/auth/logout")
    c.post("/api/auth/register", json={"token": inv["token"], "username": "joueur2", "display_name": "J2", "password": "motdepasse2"})
    assert [x["body"] for x in c.get(f"/api/matches/{mid}/comments").json()] == ["équipe"]  # le perso du coach est invisible


def test_remote_setup_needs_code_and_open_mode_is_local_only(client):
    from fastapi.testclient import TestClient
    c, _ = client
    remote = TestClient(c.app, client=("203.0.113.5", 40000))
    proxied = {"X-Forwarded-For": "203.0.113.5"}
    assert remote.get("/api/auth/me").json()["setup_code_required"] is True
    assert c.get("/api/auth/me").json()["setup_code_required"] is False
    assert remote.get("/api/matches").status_code == 401
    assert c.get("/api/matches", headers=proxied).status_code == 401  # proxy local devant : visiteur distant
    assert remote.post("/api/auth/setup", json=OWNER).status_code == 403
    assert remote.post("/api/auth/setup", json={**OWNER, "setup_code": "FAUX"}).status_code == 403
    code = c.app.state.setup_code
    assert code and len(code) == 8
    r = remote.post("/api/auth/setup", json={**OWNER, "setup_code": code.lower()})
    assert r.status_code == 200 and r.json()["user"]["role"] == "owner"
    assert c.app.state.setup_code is None
    assert remote.get("/api/matches").status_code == 200
    c.post("/api/auth/logout")
    assert c.get("/api/matches").status_code == 401  # un compte existe : plus d'accès local libre


def test_password_change_and_removal_revoke_sessions(client):
    from fastapi.testclient import TestClient
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    other = TestClient(c.app, client=("127.0.0.1", 50001))
    assert other.post("/api/auth/login", json=OWNER).status_code == 200
    r = c.patch("/api/auth/me", json={"current_password": OWNER["password"], "new_password": "nouveaumdp1"})
    assert r.status_code == 200
    assert c.get("/api/matches").status_code == 200       # cet appareil reste connecté
    assert other.get("/api/matches").status_code == 401   # les autres sont déconnectés
    inv = c.post("/api/team/invites", json={"role": "member"}).json()
    member = TestClient(c.app, client=("127.0.0.1", 50002))
    uid = member.post("/api/auth/register", json={"token": inv["token"], "username": "joueur1", "display_name": "J1",
                                                  "password": "motdepasse2"}).json()["user"]["id"]
    assert member.get("/api/matches").status_code == 200
    assert c.delete(f"/api/team/members/{uid}").status_code == 200
    assert member.get("/api/matches").status_code == 401
