# backend/tests/test_integration_events.py
import hashlib
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import ROOT, Settings
from app.ingest import remote
from app.integrations import webhooks
from app.api import demos as demos_api
from app.main import create_app
from app.storage.models import Webhook
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}


@pytest.fixture
def events(monkeypatch):
    got: list[dict] = []
    monkeypatch.setattr(webhooks, "send", lambda url, body, headers: got.append(json.loads(body)) or 200)
    monkeypatch.setattr(webhooks, "RETRY_DELAYS", (0,))
    monkeypatch.setattr(remote, "_public_host", lambda host: None)  # pas de résolution DNS à l'envoi
    return got


@pytest.fixture(autouse=True)
def _clean_downloads():
    yield
    demos_api._downloads.clear()  # les imports par outil laissent des entrées, que test_remote ne doit pas voir


def _subscribe(c):
    with c.app.state.session_factory() as db:
        db.add(Webhook(url="https://hooks.example/x", secret="s", events=json.dumps(list(webhooks.EVENTS)), active=True))
        db.commit()


def _upload(c, content: bytes):
    return c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(content), "application/octet-stream"))])


def _names(got):
    return [e["event"] for e in got]


def _wait_events(got, n, timeout=15):
    end = time.time() + timeout
    while len(got) < n and time.time() < end:
        time.sleep(0.05)
    assert webhooks.wait_idle()


def test_upload_announced_once_and_not_on_reanalysis(client, events):
    c, _ = client
    _subscribe(c)
    _upload(c, b"x" * 10)
    _upload(c, b"x" * 10)  # doublon : rien de plus
    wait_ready(c)
    _wait_events(events, 2)
    assert _names(events) == ["demo.imported", "match.ready"]
    imported, ready = (e["data"] for e in events)
    assert imported["source"] is None and imported["file_name"] == "nuke.dem"
    assert ready["map"] == "de_nuke" and len(ready["teams"]) == 2 and len(ready["score"]) == 2
    assert ready["kind"] in ("official", "practice") and ready["path"] == f"/matches/{ready['match_id']}"
    assert ready["url"] is None  # pas d'adresse publique configurée
    assert ready["our_team"] is None and ready["our_team_id"] is None  # aucun compte du site lié à un joueur
    assert c.post(f"/api/demos/{imported['demo_id']}/reparse").status_code == 200
    wait_ready(c)
    assert webhooks.wait_idle()
    assert _names(events) == ["demo.imported", "match.ready"]  # une ré-analyse n'est pas annoncée


def test_our_team_is_where_site_accounts_play(client):
    from app.integrations.ours import our_team, our_team_id
    from app.storage.models import Match, User
    c, _ = client
    _upload(c, b"y" * 10)
    wait_ready(c)
    with c.app.state.session_factory() as db:
        m = db.query(Match).first()
        a = [p.steamid for p in m.players if p.team_id == m.team_a_id]
        b = [p.steamid for p in m.players if p.team_id == m.team_b_id]
        assert our_team(db, m) is None
        db.add_all([User(username=f"u{i}", display_name="U", password_hash="x", steamid=s) for i, s in enumerate(b[:2])])
        db.add(User(username="ua", display_name="U", password_hash="x", steamid=a[0]))
        db.commit()
        assert our_team(db, m) == m.team_b.name  # 2 comptes chez B contre 1 chez A
        assert our_team_id(db, m) == m.team_b_id
        db.add(User(username="ub", display_name="U", password_hash="x", steamid=a[1]))
        db.commit()
        assert our_team(db, m) is None  # égalité : on ne choisit pas


def test_analysis_failure_announced(tmp_path, events):
    def broken_parse(path, sample_rate, build_opts, progress):
        raise ValueError("en-tête illisible")
    s = Settings(data_dir=tmp_path / "data", maps_dir=ROOT / "maps", frontend_dist=tmp_path / "nodist",
                 demo_folders=[tmp_path / "demos"])
    s._config_path = tmp_path / "config.toml"
    (tmp_path / "demos").mkdir()
    with TestClient(create_app(s, parse_fn=broken_parse, executor_factory=lambda n: ThreadPoolExecutor(n)),
                    client=("127.0.0.1", 50000)) as c:
        _subscribe(c)
        _upload(c, b"y" * 10)
        wait_ready(c)
        _wait_events(events, 2)
    assert _names(events) == ["demo.imported", "demo.failed"]
    assert "en-tête illisible" in events[1]["data"]["error"] and events[1]["data"]["source"] is None


def test_reanalysis_failure_not_announced(tmp_path, events):
    from tests.test_api import fixture_parse
    calls = []

    def parse(path, sample_rate, build_opts, progress):
        calls.append(1)
        if len(calls) > 1:
            raise ValueError("nouveau parseur cassé")
        return fixture_parse(path, sample_rate, build_opts, progress)
    s = Settings(data_dir=tmp_path / "data", maps_dir=ROOT / "maps", frontend_dist=tmp_path / "nodist",
                 demo_folders=[tmp_path / "demos"])
    s._config_path = tmp_path / "config.toml"
    (tmp_path / "demos").mkdir()
    with TestClient(create_app(s, parse_fn=parse, executor_factory=lambda n: ThreadPoolExecutor(n)),
                    client=("127.0.0.1", 50000)) as c:
        _subscribe(c)
        _upload(c, b"z" * 10)
        wait_ready(c)
        _wait_events(events, 2)
        demo_id = events[0]["data"]["demo_id"]
        assert c.post(f"/api/demos/{demo_id}/reparse").status_code == 200
        end = time.time() + 15
        while len(calls) < 2 and time.time() < end:
            time.sleep(0.05)
        demos = wait_ready(c)
        assert demos[0]["status"] == "error"
        assert webhooks.wait_idle()
    assert _names(events) == ["demo.imported", "match.ready"]  # l'échec d'une ré-analyse n'est pas annoncé


def _tool(c, monkeypatch, fail=False):
    """Clé « import » passée en en-tête ; le cookie de session reste pour suivre l'analyse (GET /api/demos)."""
    c.post("/api/auth/setup", json=OWNER)
    key = c.post("/api/integrations/keys", json={"name": "n8n", "scopes": ["import"]}).json()["key"]
    _subscribe(c)

    def fake_download(dl, dest_dir, faceit_key=None):
        if fail:
            raise remote.RemoteError("Lien de stockage expiré")
        p = Path(dest_dir) / f"{hashlib.md5(dl.url.encode()).hexdigest()}.dem"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"PBDEMS2\x00" + dl.url.encode())
        return [p]
    monkeypatch.setattr(remote, "check_url", lambda u: u)
    monkeypatch.setattr(remote, "download", fake_download)
    return {"Authorization": f"Bearer {key}"}


def test_tool_import_events_carry_the_source(client, events, monkeypatch):
    c, _ = client
    h = _tool(c, monkeypatch)
    c.post("/api/integrations/import", headers=h, json={"source": "pracc", "external_id": "u8",
           "url": "https://storage.example/u8.dem", "label": {"folder": "PRACC", "tags": ["pracc"], "opponent": "Rivals"}})
    _wait_events(events, 1)
    wait_ready(c)
    _wait_events(events, 2)
    assert _names(events) == ["demo.imported", "match.ready"]
    for e in events:
        assert (e["data"]["source"], e["data"]["external_id"], e["data"]["opponent"]) == ("pracc", "u8", "Rivals")
    assert events[1]["data"]["kind"] == "practice"


def test_download_failure_announced_with_its_source(client, events, monkeypatch):
    c, _ = client
    h = _tool(c, monkeypatch, fail=True)
    c.post("/api/integrations/import", headers=h, json={"source": "pracc", "external_id": "u7",
           "url": "https://storage.example/u7.dem", "label": {"opponent": "Rivals"}})
    _wait_events(events, 1)
    assert _names(events) == ["demo.failed"]
    assert events[0]["data"] == {"demo_id": None, "source": "pracc", "external_id": "u7", "opponent": "Rivals",
                                 "error": "Lien de stockage expiré"}
