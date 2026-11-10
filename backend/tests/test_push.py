# backend/tests/test_push.py
import io
import json
from types import SimpleNamespace

from pywebpush import WebPushException

from app.core import push
from app.core.notify import notify
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}
SUB = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc123", "keys": {"p256dh": "BPk3", "auth": "xyz"}}


def _match_ready(c, match_id):
    """Relance l'alerte « match prêt » (l'import l'a envoyée avant qu'un appareil soit abonné)."""
    with c.app.state.session_factory() as db:
        notify(db, "match_ready", "Match prêt", "", f"/matches/{match_id}", settings=c.app.state.settings)


def test_vapid_key_is_created_once(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    k1 = c.get("/api/push/key").json()["key"]
    k2 = c.get("/api/push/key").json()["key"]
    assert k1 == k2 and len(k1) == 87  # point P-256 non compressé, base64url sans « = »


def test_subscriptions_only_to_real_push_services(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    assert c.post("/api/push/subscriptions", json=SUB).json() == {"ok": True}
    assert c.post("/api/push/subscriptions", json=SUB).json() == {"ok": True}  # même appareil : mis à jour
    for bad in ("https://127.0.0.1/x", "http://fcm.googleapis.com/x", "https://evil.example/push.apple.com"):
        assert c.post("/api/push/subscriptions", json={**SUB, "endpoint": bad}).status_code == 400
    assert c.post("/api/push/subscriptions", json={"endpoint": SUB["endpoint"], "keys": {}}).status_code == 400
    assert c.request("DELETE", "/api/push/subscriptions", json={"endpoint": SUB["endpoint"]}).json() == {"ok": True}


def test_match_ready_reaches_the_players_of_the_match(client, monkeypatch):
    c, _ = client
    sent = []
    monkeypatch.setattr(push, "RUN_IN_THREAD", False)
    monkeypatch.setattr(push, "webpush", lambda **kw: sent.append(kw))
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    m = c.get(f"/api/matches/{c.get('/api/matches').json()[0]['id']}").json()
    player = m["players"][0]
    c.post("/api/auth/setup", json=OWNER)
    c.patch("/api/auth/me", json={"steamid": player["steamid"]})
    c.post("/api/push/subscriptions", json=SUB)

    _match_ready(c, m["id"])
    assert len(sent) == 1
    assert sent[0]["subscription_info"]["endpoint"] == SUB["endpoint"]
    data = json.loads(sent[0]["data"])
    opponent = m["team_b"]["name"] if player["team_id"] == m["team_a"]["id"] else m["team_a"]["name"]
    assert data["title"] == f"Ton match contre {opponent} est analysé"
    assert data["url"] == f"/app/matches/{m['id']}"

    # un joueur qui n'était pas dans le match ne reçoit rien
    c.patch("/api/auth/me", json={"steamid": "1"})
    _match_ready(c, m["id"])
    assert len(sent) == 1


def test_expired_subscriptions_are_removed(client, monkeypatch):
    c, _ = client
    monkeypatch.setattr(push, "RUN_IN_THREAD", False)

    def gone(**_kw):
        raise WebPushException("expiré", response=SimpleNamespace(status_code=410, text=""))

    monkeypatch.setattr(push, "webpush", gone)
    c.post("/api/auth/setup", json=OWNER)
    c.post("/api/push/subscriptions", json=SUB)
    with c.app.state.session_factory() as db:
        notify(db, "prep_report", "Rapport de préparation : MOUZ", "", "/match-prep/1", settings=c.app.state.settings)
    with c.app.state.session_factory() as db:
        assert db.scalar(push.select(push.func.count(push.PushSubscription.id))) == 0
