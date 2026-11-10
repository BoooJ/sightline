# backend/tests/test_webhooks.py
import base64
import hashlib
import hmac
import json

import pytest

from app.core.db import make_engine, make_session_factory
from app.ingest import remote
from app.integrations import webhooks
from app.storage.models import Webhook, WebhookDelivery
from tests.test_api import client  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}
_REAL_PUBLIC_HOST = remote._public_host


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_jwt(token: str, secret: str) -> dict:
    """Vérification indépendante, celle que fait n8n : signature HS256, puis lecture des claims."""
    head, body, sig = token.split(".")
    assert hmac.compare_digest(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest(), _unb64(sig))
    assert json.loads(_unb64(head)) == {"alg": "HS256", "typ": "JWT"}
    return json.loads(_unb64(body))


@pytest.fixture
def sent(monkeypatch):
    """Envois capturés ; `codes` : réponses successives du faux serveur (200 ensuite)."""
    calls, codes = [], []

    def fake_send(url, body, headers):
        calls.append({"url": url, "body": json.loads(body), "raw": body, "headers": headers})
        return codes.pop(0) if codes else 200

    monkeypatch.setattr(webhooks, "send", fake_send)
    monkeypatch.setattr(webhooks, "RETRY_DELAYS", (0, 0, 0))
    monkeypatch.setattr(remote, "_public_host", lambda host: None)  # hôtes de test : pas de vrai DNS
    return calls, codes


@pytest.fixture
def sf(db_url):
    return make_session_factory(make_engine(db_url))


def _hook(sf, events=("match.ready",), active=True):
    with sf() as db:
        h = Webhook(url="https://hooks.example/x", secret="s3cret", events=json.dumps(list(events)), active=active)
        db.add(h)
        db.commit()
        return h.id


def test_jwt_signed_with_secret_and_body_hash(sf, sent):
    calls, _ = sent
    hid = _hook(sf)
    assert webhooks.deliver(sf, hid, "https://hooks.example/x", "s3cret", "match.ready", {"match_id": 7})
    [c] = calls
    assert c["body"]["event"] == "match.ready" and c["body"]["data"] == {"match_id": 7}
    assert c["headers"]["X-Sightline-Event"] == "match.ready"
    claims = verify_jwt(c["headers"]["Authorization"].removeprefix("Bearer "), "s3cret")
    assert claims["iss"] == "sightline" and claims["delivery"] == c["body"]["id"] and claims["event"] == "match.ready"
    assert claims["exp"] - claims["iat"] == 300
    assert claims["body_sha256"] == hashlib.sha256(c["raw"]).hexdigest()


def test_three_attempts_then_logged(sf, sent):
    _, codes = sent
    hid = _hook(sf)
    codes.extend([500, 502])
    assert webhooks.deliver(sf, hid, "https://hooks.example/x", "s", "match.ready", {}) is True
    codes.extend([500, 500, 500])
    assert webhooks.deliver(sf, hid, "https://hooks.example/x", "s", "match.ready", {}) is False
    with sf() as db:
        log = [(d.attempt, d.status_code, d.error) for d in db.query(WebhookDelivery).order_by(WebhookDelivery.id)]
    assert log == [(1, 500, "HTTP 500"), (2, 502, "HTTP 502"), (3, 200, None),
                   (1, 500, "HTTP 500"), (2, 500, "HTTP 500"), (3, 500, "HTTP 500")]


def test_network_error_counts_as_an_attempt(sf, monkeypatch):
    monkeypatch.setattr(webhooks, "RETRY_DELAYS", (0, 0))
    monkeypatch.setattr(remote, "_public_host", lambda host: None)

    def refused(*a):
        raise OSError("connexion refusée")
    monkeypatch.setattr(webhooks, "send", refused)
    hid = _hook(sf)
    assert webhooks.deliver(sf, hid, "https://x.example", "s", "ping", {}) is False
    with sf() as db:
        assert [d.error for d in db.query(WebhookDelivery)] == ["connexion refusée"] * 2


def test_private_address_refused_at_every_attempt(sf, monkeypatch):
    """Sans patch de _public_host : l'adresse est revérifiée avant chaque essai, send n'est jamais appelé."""
    calls = []
    monkeypatch.setattr(webhooks, "send", lambda *a: calls.append(a) or 200)
    monkeypatch.setattr(webhooks, "RETRY_DELAYS", (0, 0))
    hid = _hook(sf)
    assert webhooks.deliver(sf, hid, "https://127.0.0.1/x", "s", "ping", {}) is False
    assert calls == []
    with sf() as db:
        rows = [(d.attempt, d.status_code, d.error) for d in db.query(WebhookDelivery).order_by(WebhookDelivery.id)]
    assert len(rows) == 2
    assert all(code is None and "privée" in err for _, code, err in rows)


def test_emit_only_to_active_subscribers(sf, sent):
    calls, _ = sent
    _hook(sf, events=("match.ready",))
    _hook(sf, events=("demo.failed",))
    _hook(sf, events=("match.ready",), active=False)
    assert webhooks.emit(sf, "match.ready", {"match_id": 1}) == 1
    assert webhooks.wait_idle()
    assert len(calls) == 1


def test_log_keeps_the_latest(sf, sent, monkeypatch):
    monkeypatch.setattr(webhooks, "KEEP", 3)
    hid = _hook(sf)
    for _ in range(5):
        webhooks.deliver(sf, hid, "https://x.example", "s", "ping", {})
    with sf() as db:
        assert db.query(WebhookDelivery).count() == 3


def test_webhook_routes(client, sent, monkeypatch):
    calls, _ = sent
    monkeypatch.setattr(remote, "_public_host", _REAL_PUBLIC_HOST)  # la vraie vérification pour la route
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    new = lambda url, events: c.post("/api/integrations/webhooks", json={"url": url, "events": events})  # noqa: E731
    assert new("http://n8n.example/w", ["match.ready"]).status_code == 400   # https obligatoire
    assert new("https://127.0.0.1/w", ["match.ready"]).status_code == 400    # adresse interne refusée
    assert new("https://a..b/w", ["match.ready"]).status_code == 400         # nom d'hôte mal formé : 400, pas 500
    monkeypatch.setattr(remote, "_public_host", lambda host: None)
    assert new("https://n8n.example/w", ["nope"]).status_code == 400
    r = new("https://n8n.example/w", ["match.ready", "demo.imported"])
    assert r.status_code == 200 and len(r.json()["secret"]) >= 40
    hook = r.json()
    assert hook["events"] == ["demo.imported", "match.ready"]  # ordre canonique
    listed = c.get("/api/integrations/webhooks").json()
    assert listed[0]["url"] == "https://n8n.example/w" and "secret" not in listed[0]
    assert c.post(f"/api/integrations/webhooks/{hook['id']}/test").json() == {"ok": True}
    assert webhooks.wait_idle()
    assert calls[-1]["body"]["event"] == "ping"
    verify_jwt(calls[-1]["headers"]["Authorization"].removeprefix("Bearer "), hook["secret"])
    d = c.get("/api/integrations/webhooks/deliveries").json()
    assert d[0]["event"] == "ping" and d[0]["status_code"] == 200
    assert c.patch(f"/api/integrations/webhooks/{hook['id']}", json={"active": False}).json()["active"] is False
    assert c.delete(f"/api/integrations/webhooks/{hook['id']}").json() == {"ok": True}
    assert c.get("/api/integrations/webhooks").json() == []
