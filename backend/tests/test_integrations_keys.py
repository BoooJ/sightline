# backend/tests/test_integrations_keys.py
from sqlalchemy import select

from app.integrations import keys
from app.storage.models import ApiKey
from tests.test_api import client  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}


def _key(c, scopes, name="n8n"):
    r = c.post("/api/integrations/keys", json={"name": name, "scopes": scopes})
    assert r.status_code == 200, r.text
    return r.json()


def test_key_shown_once_and_stored_hashed(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    made = _key(c, ["read", "import"])
    assert made["key"].startswith("sl_") and made["prefix"] == made["key"][:8]
    assert made["scopes"] == ["import", "read"] and made["revoked"] is False
    listed = c.get("/api/integrations/keys").json()
    assert [k["name"] for k in listed] == ["n8n"] and "key" not in listed[0]
    with c.app.state.session_factory() as db:
        row = db.scalar(select(ApiKey))
        assert row.key_hash == keys.key_hash(made["key"]) and made["key"] not in (row.key_hash, row.prefix)


def test_key_input_validated(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    assert c.post("/api/integrations/keys", json={"name": "", "scopes": ["read"]}).status_code == 400
    assert c.post("/api/integrations/keys", json={"name": "x", "scopes": []}).status_code == 400
    assert c.post("/api/integrations/keys", json={"name": "x", "scopes": ["admin"]}).status_code == 400


def test_key_limited_to_its_scopes(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    read = _key(c, ["read"], "lecture")["key"]
    imp = _key(c, ["import"], "import")["key"]
    c.cookies.clear()

    def h(k):
        return {"Authorization": f"Bearer {k}"}
    assert c.get("/api/matches", headers=h(read)).status_code == 200
    assert c.get("/api/settings", headers=h(read)).status_code == 403  # le webhook Discord n'est jamais lisible
    assert c.get("/api/integrations/keys", headers=h(read)).status_code == 403
    assert c.delete("/api/demos/1", headers=h(read)).status_code == 403
    assert c.get("/api/matches", headers=h(imp)).status_code == 403
    assert c.get("/api/auth/me", headers=h(read)).json()["user"] is None  # aucun droit de compte
    assert c.get("/api/matches", headers=h("sl_inconnue")).status_code == 401


def test_key_accepted_without_bearer_prefix(client):
    # une clé collée seule dans l'identifiant n8n (sans « Bearer ») doit marcher ; un jeton quelconque, non
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    imp = _key(c, ["import"])["key"]
    c.cookies.clear()
    known = {"source": "pracc", "ids": []}
    assert c.post("/api/integrations/known", json=known, headers={"Authorization": imp}).status_code == 200
    assert c.post("/api/integrations/known", json=known, headers={"Authorization": f" {imp} "}).status_code == 200
    assert c.post("/api/integrations/known", json=known, headers={"Authorization": "sl_inconnue"}).status_code == 401
    assert c.post("/api/integrations/known", json=known, headers={"Authorization": "Basic abc"}).status_code == 401


def test_revoked_key_refused_and_last_use_recorded(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    made = _key(c, ["read"])
    assert made["last_used_at"] is None
    h = {"Authorization": f"Bearer {made['key']}"}
    assert c.get("/api/matches", headers=h).status_code == 200
    assert c.get("/api/integrations/keys").json()[0]["last_used_at"] is not None
    assert c.delete(f"/api/integrations/keys/{made['id']}").json()["revoked"] is True
    c.cookies.clear()
    assert c.get("/api/matches", headers=h).status_code == 401


def test_allows_rules():
    assert keys.allows(["read"], "GET", "/api/matches/3/debrief")
    assert keys.allows(["read"], "GET", "/api/matches")
    assert not keys.allows(["read"], "GET", "/api/matchesX")
    assert not keys.allows(["read"], "POST", "/api/matches/3/debrief")
    assert keys.allows(["import"], "POST", "/api/integrations/import")
    assert not keys.allows(["import"], "GET", "/api/integrations/import")
    assert not keys.allows(["import"], "POST", "/api/integrations/keys")
