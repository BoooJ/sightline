# backend/tests/test_owner_only.py
from tests.test_api import client  # noqa: F401  (fixture)
from tests.test_team import OWNER

HOOK = "https://discord.com/api/webhooks/1/jeton-factice"


def _join(c, role, username):
    """Invitation créée par le compte connecté, puis inscription : le client devient ce nouveau compte."""
    inv = c.post("/api/team/invites", json={"role": role}).json()
    c.post("/api/auth/logout")
    r = c.post("/api/auth/register", json={"token": inv["token"], "username": username, "display_name": username,
                                           "password": "motdepasse2"})
    assert r.json()["user"]["role"] == role


def test_keys_and_secrets_are_owner_only(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    assert c.put("/api/settings", json={"discord_webhook": HOOK}).status_code == 200
    assert c.get("/api/settings").json()["discord_webhook"] == HOOK
    assert c.get("/api/integrations/keys").status_code == 200
    assert c.get("/api/ai/status").json()["can_configure"] is True

    _join(c, "admin", "adjoint")  # un administrateur gère l'équipe, pas les clés
    assert c.get("/api/integrations/keys").status_code == 403
    assert c.post("/api/integrations/keys", json={"name": "x", "scopes": ["read"]}).status_code == 403
    assert c.get("/api/integrations/webhooks").status_code == 403
    assert c.get("/api/discord/config").status_code == 403
    assert c.put("/api/ai/config", json={"clear_key": True}).status_code == 403
    assert c.put("/api/faceit/config", json={"clear_key": True}).status_code == 403
    assert c.get("/api/ai/status").json()["can_configure"] is False
    assert c.get("/api/faceit/status").json()["can_configure"] is False
    assert c.get("/api/settings").json()["discord_webhook"] == ""
    assert c.put("/api/settings", json={"discord_webhook": ""}).status_code == 403
    assert c.put("/api/settings", json={"public_url": "https://exemple.test"}).status_code == 200
    assert c.get("/api/team/invites").status_code == 200  # les invitations restent aux administrateurs

    _join(c, "member", "joueur")
    assert c.get("/api/settings").json()["discord_webhook"] == ""
    assert c.put("/api/settings", json={"public_url": ""}).status_code == 403
