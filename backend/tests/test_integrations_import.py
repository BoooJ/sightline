# backend/tests/test_integrations_import.py
import hashlib
import json
import time
from pathlib import Path

import pytest

from app.api import demos as demos_api
from app.core.db import make_engine, make_session_factory
from app.ingest import remote
from app.integrations import sources
from app.storage.labels import match_kind
from app.storage.models import Demo, DemoSource, Match, MatchLabel
from tests.test_api import client  # noqa: F401  (fixture)

OWNER = {"username": "coach", "display_name": "Coach", "password": "motdepasse1"}
LABEL = {"folder": "PRACC", "played_on": "2026-10-20", "tags": ["pracc", "Rivals"], "opponent": "Rivals"}


@pytest.fixture
def tool(client, monkeypatch):
    """Client authentifié par une clé « import + read » ; téléchargements simulés, contenu propre à chaque lien."""
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    key = c.post("/api/integrations/keys", json={"name": "n8n", "scopes": ["import", "read"]}).json()["key"]
    c.cookies.clear()
    calls: list[str] = []

    def fake_download(dl, dest_dir, faceit_key=None):
        calls.append(dl.url)
        if "expire" in dl.url:
            raise remote.RemoteError("Lien de stockage expiré")
        p = Path(dest_dir) / f"{hashlib.md5(dl.url.encode()).hexdigest()}.dem"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"PBDEMS2\x00" + dl.url.encode())
        return [p]

    monkeypatch.setattr(remote, "check_url", lambda u: u)
    monkeypatch.setattr(remote, "download", fake_download)
    yield c, {"Authorization": f"Bearer {key}"}, calls
    demos_api._downloads.clear()  # liste globale du module : ne pas la laisser aux autres tests


def _import(c, h, uid, url=None, label=LABEL):
    return c.post("/api/integrations/import", headers=h, json={
        "source": "pracc", "external_id": uid, "url": url or f"https://storage.example/{uid}.dem", "label": label})


def _settled(c, source_id, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        with c.app.state.session_factory() as db:
            row = db.get(DemoSource, source_id)
            if row.status not in ("downloading", "importing"):
                return row
        time.sleep(0.1)
    raise AssertionError("téléchargement trop long")


def _analysed(c, demo_id, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        with c.app.state.session_factory() as db:
            if db.get(Demo, demo_id).status in ("ready", "error"):
                return
        time.sleep(0.2)
    raise AssertionError("analyse trop longue")


def test_import_labels_the_demo_then_knows_it(tool):
    c, h, calls = tool
    r = _import(c, h, "u1")
    assert r.status_code == 200 and r.json()["status"] == "started"
    row = _settled(c, r.json()["source_id"])
    assert row.status == "done" and row.demo_id
    _analysed(c, row.demo_id)
    with c.app.state.session_factory() as db:
        lab = db.get(MatchLabel, row.demo_id)
        assert lab.folder == "PRACC" and json.loads(lab.tags) == ["pracc", "Rivals"]
        assert lab.played_on.isoformat() == "2026-10-20"
        assert match_kind(db.query(Match).filter(Match.demo_id == row.demo_id).one()) == "practice"
    known = c.post("/api/integrations/known", headers=h, json={"source": "pracc", "ids": ["u1", "u2"]})
    assert known.json() == {"known": ["u1"]}
    again = _import(c, h, "u1").json()
    assert again["status"] == "known" and again["demo_id"] == row.demo_id
    assert calls == ["https://storage.example/u1.dem"]  # rien de retéléchargé


def test_form_upload_labels_the_demo_and_skips_duplicates(tool):
    # formulaire d'import de n8n : le fichier arrive directement, repéré par son empreinte
    c, h, _ = tool

    def up(content, name="ma demo.dem", opponent="Rivals", headers=h):
        return c.post("/api/integrations/upload", headers=headers, data={"opponent": opponent},
                      files={"file": (name, content, "application/octet-stream")})
    r = up(b"PBDEMS2\x00formulaire-1")
    assert r.status_code == 200 and r.json()["status"] == "imported"
    demo_id = r.json()["demo_id"]
    _analysed(c, demo_id)
    with c.app.state.session_factory() as db:
        lab = db.get(MatchLabel, demo_id)
        assert lab.folder == "Formulaire" and json.loads(lab.tags) == ["formulaire", "Rivals"]
        row = db.query(DemoSource).filter(DemoSource.source == "form").one()
        assert row.status == "done" and row.demo_id == demo_id
    assert up(b"PBDEMS2\x00formulaire-1").json() == {"status": "known", "demo_id": demo_id}
    assert up(b"PBDEMS2\x00autre", name="notes.txt").status_code == 400
    assert up(b"PBDEMS2\x00autre", headers={}).status_code == 401
    without_opponent = up(b"PBDEMS2\x00formulaire-2", opponent="")
    with c.app.state.session_factory() as db:
        assert json.loads(db.get(MatchLabel, without_opponent.json()["demo_id"]).tags) == ["formulaire"]


def test_failed_import_retried_then_abandoned(tool):
    c, h, calls = tool
    for attempt, status in ((1, "error"), (2, "error"), (3, "abandoned")):
        r = _import(c, h, "u9", url="https://storage.example/expire.dem")
        assert r.json()["status"] == "started"
        row = _settled(c, r.json()["source_id"])
        assert (row.status, row.attempts) == (status, attempt) and "expiré" in row.error
        known = c.post("/api/integrations/known", headers=h, json={"source": "pracc", "ids": ["u9"]}).json()["known"]
        assert known == ([] if status == "error" else ["u9"])
    assert _import(c, h, "u9", url="https://storage.example/expire.dem").json()["status"] == "known"
    assert len(calls) == 3


def test_same_file_under_two_ids_shares_the_demo(tool):
    c, h, _ = tool
    a = _settled(c, _import(c, h, "a", url="https://storage.example/same.dem").json()["source_id"])
    b = _settled(c, _import(c, h, "b", url="https://storage.example/same.dem", label={"folder": "Autre"}).json()["source_id"])
    assert a.demo_id == b.demo_id and b.status == "done"
    with c.app.state.session_factory() as db:
        assert db.get(MatchLabel, a.demo_id).folder == "PRACC"  # le doublon ne réétiquette pas


def test_import_input_checked(tool):
    c, h, _ = tool
    post = lambda body: c.post("/api/integrations/import", headers=h, json=body)  # noqa: E731
    assert post({"source": "hltv", "external_id": "x", "url": "https://a.example/b"}).status_code == 400
    assert post({"source": "pracc", "external_id": "", "url": "https://a.example/b"}).status_code == 400
    assert _import(c, h, "x", label={"played_on": "20/10/2026"}).status_code == 400
    assert _import(c, h, "x", label={"tags": ["x"] * 11}).status_code == 400
    assert c.post("/api/integrations/known", headers=h, json={"source": "pracc", "ids": "u1"}).status_code == 400


def test_import_routes_need_an_import_key(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)  # session de propriétaire, mais pas de clé
    assert c.post("/api/integrations/known", json={"source": "pracc", "ids": []}).status_code == 403
    read = c.post("/api/integrations/keys", json={"name": "r", "scopes": ["read"]}).json()["key"]
    c.cookies.clear()
    assert c.post("/api/integrations/known", headers={"Authorization": f"Bearer {read}"},
                  json={"source": "pracc", "ids": []}).status_code == 403


def test_interrupted_downloads_reset(db_url):
    sf = make_session_factory(make_engine(db_url))
    with sf() as db:
        db.add(DemoSource(source="pracc", external_id="z", status="importing"))
        db.commit()
    assert sources.reset_interrupted(sf) == 1
    with sf() as db:
        row = db.query(DemoSource).one()
        assert row.status == "error" and "redémarrage" in row.error and row.attempts == 0
