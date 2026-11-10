# backend/tests/test_notifications.py
"""Notifications : match prêt après import, commentaire, rapport de préparation ; réglages Discord ; purge."""
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_notifications_flow(client):
    c, _ = client
    assert c.get("/api/notifications").json() == []
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    notes = c.get("/api/notifications").json()
    assert len(notes) == 1 and notes[0]["kind"] == "match_ready" and "FaZe" in notes[0]["title"] and notes[0]["link"].startswith("/matches/")
    mid = c.get("/api/matches").json()[0]["id"]
    c.post(f"/api/matches/{mid}/comments", json={"body": "bien joué"})
    notes = c.get("/api/notifications").json()
    assert notes[0]["kind"] == "comment" and "bien joué" in notes[0]["body"]
    faze = next(t for t in c.get("/api/scouting/teams").json() if t["name"] == "FaZe")
    tpl = c.get("/api/prep/templates").json()[0]
    c.post("/api/prep/reports", json={"team_id": faze["id"], "map": "de_nuke", "template_id": tpl["id"]})
    notes = c.get("/api/notifications").json()
    assert notes[0]["kind"] == "prep_report" and notes[0]["link"].startswith("/match-prep/")
    assert len(c.get(f"/api/notifications?after={notes[-1]['id']}").json()) == 2
    # réglages Discord (webhook vide : rien n'est envoyé)
    s = c.put("/api/settings", json={"discord_webhook": "", "notify_discord": True}).json()
    assert s["discord_webhook"] == "" and s["notify_discord"] is True
    assert c.post("/api/notifications/test").status_code == 400
    assert c.delete("/api/notifications").json()["ok"] and c.get("/api/notifications").json() == []


def test_match_ready_left_to_outgoing_webhook_on_discord(client, monkeypatch):
    """Un webhook sortant abonné à match.ready (n8n W2) annonce déjà les démos analysées sur Discord : pas de doublon
    « Match prêt » ; commentaires et rapports y passent toujours."""
    from types import SimpleNamespace

    from app.core import notify as nt
    from app.storage.models import Webhook
    c, _ = client
    sent: list[str] = []
    monkeypatch.setattr(nt, "_discord", lambda url, text: sent.append(text))
    monkeypatch.setattr(nt.threading, "Thread", lambda target, args, daemon: SimpleNamespace(start=lambda: target(*args)))
    st = SimpleNamespace(discord_webhook="https://discord.com/api/webhooks/1/x", notify_discord=True, public_url="")
    with c.app.state.session_factory() as db:
        nt.notify(db, "match_ready", "Match prêt : A 13–9 B", settings=st)
        db.add(Webhook(url="https://n8n.example/webhook/x", secret="s", events='["demo.imported", "match.ready"]'))
        db.add(Webhook(url="https://n8n.example/webhook/y", secret="s", events="pas du json"))
        db.commit()
        nt.notify(db, "match_ready", "Match prêt : C 13–5 D", settings=st)
        nt.notify(db, "comment", "Paul a commenté", settings=st)
    assert [t.split("\n")[0] for t in sent] == ["**Match prêt : A 13–9 B**", "**Paul a commenté**"]


def test_comms_left_to_outgoing_webhook_on_discord(client, monkeypatch):
    """Un webhook sortant abonné à comms.ready (n8n W2) annonce déjà les comms ajoutées : pas de doublon Discord."""
    from types import SimpleNamespace

    from app.core import notify as nt
    from app.storage.models import Webhook
    c, _ = client
    sent: list[str] = []
    monkeypatch.setattr(nt, "_discord", lambda url, text: sent.append(text))
    monkeypatch.setattr(nt.threading, "Thread", lambda target, args, daemon: SimpleNamespace(start=lambda: target(*args)))
    st = SimpleNamespace(discord_webhook="https://discord.com/api/webhooks/1/x", notify_discord=True, public_url="")
    with c.app.state.session_factory() as db:
        nt.notify(db, "comms", "Comms ajoutées : A 13–9 B", settings=st)
        db.add(Webhook(url="https://n8n.example/webhook/x", secret="s", events='["comms.ready"]'))
        db.commit()
        nt.notify(db, "comms", "Comms ajoutées : C 13–5 D", settings=st)
    assert [t.split("\n")[0] for t in sent] == ["**Comms ajoutées : A 13–9 B**"]
