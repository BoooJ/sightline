# backend/tests/test_mobile_auth.py
from tests.test_api import client  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}


def test_bearer_token_login_and_logout(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    c.post("/api/auth/logout")
    c.cookies.clear()
    assert c.post("/api/auth/token", json={"username": "coach", "password": "faux"}).status_code == 401
    r = c.post("/api/auth/token", json={"username": "COACH", "password": "motdepasse1"})
    assert r.status_code == 200 and r.json()["user"]["username"] == "coach"
    assert "sl_session" not in r.cookies  # l'app native garde le jeton elle-même
    tok = r.json()["token"]
    assert c.get("/api/matches").status_code == 401
    h = {"Authorization": f"Bearer {tok}"}
    assert c.get("/api/matches", headers=h).status_code == 200
    assert c.get("/api/auth/me", headers=h).json()["user"]["username"] == "coach"
    assert c.get("/api/matches", headers={"Authorization": "Bearer faux"}).status_code == 401
    assert c.post("/api/auth/logout", headers=h).status_code == 200
    assert c.get("/api/matches", headers=h).status_code == 401


def test_cors_allows_expo_web_dev(client):
    c, _ = client
    r = c.options("/api/health", headers={"Origin": "http://localhost:8081", "Access-Control-Request-Method": "GET",
                                          "Access-Control-Request-Headers": "authorization"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:8081"
