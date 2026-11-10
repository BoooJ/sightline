"""Comms TeamSpeak du plugin Sightline : réception, rattachement au match, décalage, pseudo TeamSpeak → joueur."""
import io
import json
import time
from datetime import datetime, timedelta

import pytest

from app.integrations import comms, keys, webhooks
from app.storage.models import CommsSession, Match, MatchAudio, MatchPlayer, Round, User
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)
from tests.test_integrations_import import OWNER

A0 = datetime(2026, 10, 24, 19, 30, 0)


def _iso(d: datetime) -> str:
    return d.isoformat() + "Z"


def test_comms_scope_event_and_ts_nickname(client):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    assert "comms" in keys.SCOPES and "comms.ready" in webhooks.EVENTS
    assert keys.allows(["comms"], "POST", "/api/integrations/comms")
    assert not keys.allows(["comms"], "POST", "/api/integrations/import")
    assert not keys.allows(["import"], "POST", "/api/integrations/comms")
    me = c.patch("/api/auth/me", json={"ts_nickname": "  sk1zy  "}).json()
    assert me["ts_nickname"] == "sk1zy"
    assert c.get("/api/auth/me").json()["user"]["ts_nickname"] == "sk1zy"
    assert c.patch("/api/auth/me", json={"ts_nickname": "x" * 65}).status_code == 400
    assert c.patch("/api/auth/me", json={"ts_nickname": ""}).json()["ts_nickname"] is None
    k = c.post("/api/integrations/keys", json={"name": "plugin", "scopes": ["comms"]})
    assert k.status_code == 200 and k.json()["scopes"] == ["comms"]


def test_clean_session_rejects_bad_input():
    good = {"plugin": "1.0.0", "recorder_steamid": "76561198000000001", "started_at": _iso(A0), "map": "de_nuke",
            "score": [13, 9], "rounds": [{"n": 1, "live_at": _iso(A0 + timedelta(seconds=75))}],
            "tracks": [{"file": "t1.ogg", "ts_uid": "u1=", "ts_nickname": "sk1zy", "self": True}]}
    s = comms.clean_session(good, {"t1.ogg"})
    assert s["started_at"] == A0.isoformat() and s["rounds"][0]["live_at"] == (A0 + timedelta(seconds=75)).isoformat()
    for bad, files in [({**good, "map": "Nuke!"}, {"t1.ogg"}), ({**good, "started_at": "hier"}, {"t1.ogg"}),
                       ({**good, "started_at": A0.isoformat()}, {"t1.ogg"}),  # sans fuseau
                       ({**good, "score": [13]}, {"t1.ogg"}), (good, set()), ({**good, "tracks": []}, {"t1.ogg"}),
                       ({**good, "recorder_steamid": "abc"}, {"t1.ogg"}),
                       ({**good, "tracks": ["t1.ogg"]}, {"t1.ogg"}), ({**good, "rounds": {"n": 1}}, {"t1.ogg"}),
                       ({**good, "score": [True, 9]}, {"t1.ogg"})]:
        with pytest.raises(ValueError):
            comms.clean_session(bad, files)


def test_offset_is_the_median_without_outliers():
    starts = {1: 10.0, 2: 100.0, 3: 200.0, 4: 300.0}
    rounds = [{"n": n, "live_at": (A0 + timedelta(seconds=40 + d)).isoformat()} for n, d in starts.items()]
    rounds[2]["live_at"] = (A0 + timedelta(seconds=40 + 200 + 5)).isoformat()  # message GSI en retard de 5 s : écarté
    assert comms.compute_offset(A0, rounds, starts) == 40.0
    assert comms.compute_offset(A0, [], starts) is None
    assert comms.compute_offset(A0, [{"n": 9, "live_at": A0.isoformat()}], starts) is None  # round absent de la démo


def test_offset_when_every_round_is_an_outlier():
    starts = {1: 10.0, 2: 100.0}
    rounds = [{"n": 1, "live_at": (A0 + timedelta(seconds=50)).isoformat()},  # décalage 40
              {"n": 2, "live_at": (A0 + timedelta(seconds=150)).isoformat()}]  # décalage 50
    assert comms.compute_offset(A0, rounds, starts) == 45.0


def _match_facts(c):
    with c.app.state.session_factory() as db:
        m = db.query(Match).first()
        players = [p.steamid for p in db.query(MatchPlayer).filter(MatchPlayer.match_id == m.id)]
        rounds = {r.number: r.freeze_end_tick for r in db.query(Round).filter(Round.match_id == m.id)}
        return {"id": m.id, "score_a": m.score_a, "score_b": m.score_b, "tickrate": m.demo_tickrate}, players, rounds


def test_find_match_attach_and_nicknames(client, tmp_path):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    m, players, rounds = _match_facts(c)
    started = datetime.utcnow() - timedelta(minutes=50)
    with c.app.state.session_factory() as db:
        owner = db.query(User).first()
        owner.ts_nickname, owner.steamid = "SK1ZY ", players[1]
        db.commit()
        s = {"plugin": "1.0.0", "recorder_steamid": players[0], "started_at": started.isoformat(), "map": "de_nuke",
             "score": [m["score_b"], m["score_a"]],
             "rounds": [{"n": n, "live_at": (started + timedelta(seconds=30 + t / m["tickrate"])).isoformat(), "over_at": None}
                        for n, t in sorted(rounds.items())[:5]],
             "tracks": [{"file": "t1.ogg", "ts_uid": "u1", "ts_nickname": "sk1zy", "self": True},
                        {"file": "t2.ogg", "ts_uid": "u2", "ts_nickname": "Invité", "self": False}]}
        found = comms.find_match(db, s)
        assert found is not None and found.id == m["id"]
        assert comms.find_match(db, {**s, "score": [99, 0]}) is None
        assert comms.find_match(db, {**s, "map": "de_mirage"}) is None
        assert comms.find_match(db, {**s, "recorder_steamid": "1"}) is None
        assert comms.find_match(db, {**s, "started_at": (started - timedelta(hours=60)).isoformat()}) is None
        folder = tmp_path / "s1"
        folder.mkdir()
        for f in ("t1.ogg", "t2.ogg"):
            (folder / f).write_bytes(b"OggS" + f.encode())
        row = CommsSession(status="waiting", recorder_steamid=players[0], map_name="de_nuke", started_at=started,
                           payload=json.dumps(s), folder=str(folder))
        db.add(row)
        db.flush()
        made = comms.attach(db, row, found, tmp_path / "audio")
        db.commit()
        assert row.status == "attached" and row.match_id == m["id"] and row.offset_s == pytest.approx(30.0, abs=0.01)
        assert [(a.label, a.steamid) for a in made] == [("sk1zy", players[1]), ("Invité", None)]
        assert all(a.offset_s == row.offset_s and a.demo_id == found.demo_id for a in made)
        assert len(list((tmp_path / "audio").iterdir())) == 2
        assert db.query(MatchAudio).count() == 2
        assert comms.steamid_for(db, "  Sk1zy") == players[1] and comms.steamid_for(db, "inconnu") is None


def _key(c, scopes=("comms",)):
    return c.post("/api/integrations/keys", json={"name": "plugin", "scopes": list(scopes)}).json()["key"]


def _post(c, key, session, files=("t1.ogg",), size=20):
    parts = [("session", (None, json.dumps(session), "application/json"))]
    parts += [("files", (f, io.BytesIO(b"OggS" + b"\0" * size), "audio/ogg")) for f in files]
    return c.post("/api/integrations/comms", files=parts, headers={"Authorization": key})


def _session(started, **kw):
    return {"plugin": "1.0.0", "recorder_steamid": None, "started_at": started.isoformat() + "Z", "map": "de_nuke",
            "score": None, "rounds": [],
            "tracks": [{"file": "t1.ogg", "ts_uid": "u1", "ts_nickname": "sk1zy", "self": True}], **kw}


def _wait_status(c, sid, status, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        if any(r["id"] == sid and r["status"] == status for r in c.get("/api/integrations/comms").json()["sessions"]):
            return True
        time.sleep(0.2)
    return False


def test_receive_waits_for_the_demo_then_attaches(client, monkeypatch):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    key, other = _key(c), _key(c, ("import",))
    sent = []
    monkeypatch.setattr(webhooks, "emit", lambda sf, event, data: sent.append((event, data)) or 1)
    started = datetime.utcnow() - timedelta(minutes=5)
    assert _post(c, other, _session(started)).status_code == 403
    assert _post(c, key, {**_session(started), "map": "??"}).status_code == 400
    assert _post(c, key, _session(started), files=()).status_code == 400  # piste annoncée sans fichier
    r = _post(c, key, _session(started)).json()
    assert r["status"] == "waiting" and r["match_id"] is None
    assert c.get("/api/integrations/comms").json()["plugin"] is False
    assert c.get("/api/integrations/comms/plugin").status_code == 404
    # la démo arrive : la session se rattache toute seule (relance après import)
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    assert _wait_status(c, r["session_id"], "attached")
    mid = c.get("/api/matches").json()[0]["id"]
    assert [t["label"] for t in c.get(f"/api/matches/{mid}/audio").json()] == ["sk1zy"]
    assert any(e == "comms.ready" and d["match_id"] == mid and d["tracks"] == 1 for e, d in sent)
    assert any(n["kind"] == "comms" for n in c.get("/api/notifications").json())


def test_receive_limits(client, monkeypatch):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    key = _key(c)
    monkeypatch.setattr(comms, "MAX_BYTES", 100)
    started = datetime.utcnow()
    assert _post(c, key, _session(started), size=500).status_code == 413
    many = [f"t{i}.ogg" for i in range(13)]
    too_many = _session(started, tracks=[{"file": f, "ts_nickname": f} for f in many])
    assert _post(c, key, too_many, files=many).status_code == 400


def test_receive_rejects_oversized_content_length(client):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    key = _key(c)
    r = c.post("/api/integrations/comms", content=b"x", headers={
        "Authorization": key, "Content-Length": str(comms.MAX_BYTES + comms.MULTIPART_SLACK + 1)})
    assert r.status_code == 413


def test_settle_twice_attaches_once(client, tmp_path, monkeypatch):  # noqa: F811
    import threading
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    sent = []
    monkeypatch.setattr(webhooks, "emit", lambda sf, event, data: sent.append(event) or 1)
    started = datetime.utcnow() - timedelta(minutes=5)
    folder = tmp_path / "s2"
    folder.mkdir()
    (folder / "t1.ogg").write_bytes(b"OggS")
    s = comms.clean_session(_session(started), {"t1.ogg"})
    with c.app.state.session_factory() as db:
        row = CommsSession(status="waiting", recorder_steamid=None, map_name="de_nuke", started_at=started,
                           payload=json.dumps(s), folder=str(folder))
        db.add(row)
        db.commit()
        sid = row.id
    threads = [threading.Thread(target=comms.settle, args=(c.app.state, sid)) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    with c.app.state.session_factory() as db:
        assert db.get(CommsSession, sid).status == "attached"
        assert db.query(MatchAudio).count() == 1
    assert sent == ["comms.ready"]
    assert not folder.exists()  # fichiers déplacés vers le dossier audio, dossier de session supprimé
    audio = c.app.state.settings.data_dir / "audio"
    assert [p.name for p in audio.glob("*-comms*")] and all(p.stat().st_size for p in audio.glob("*-comms*"))
    note = [n for n in c.get("/api/notifications").json() if n["kind"] == "comms"][0]
    assert "à caler à la main" in note["body"]  # pas de round GSI : décalage inconnu, pas « calées »


def test_attach_failure_keeps_a_generic_error(client, tmp_path):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    started = datetime.utcnow() - timedelta(minutes=5)
    folder = tmp_path / "s3"
    folder.mkdir()  # t1.ogg manque : le déplacement échoue
    s = comms.clean_session(_session(started), {"t1.ogg"})
    with c.app.state.session_factory() as db:
        row = CommsSession(status="waiting", recorder_steamid=None, map_name="de_nuke", started_at=started,
                           payload=json.dumps(s), folder=str(folder))
        db.add(row)
        db.commit()
        sid = row.id
    comms.settle(c.app.state, sid)
    with c.app.state.session_factory() as db:
        got = db.get(CommsSession, sid)
        assert got.status == "waiting" and got.error == "Rattachement impossible, nouvel essai au prochain import"
        assert str(tmp_path) not in got.error


def test_list_marks_old_waiting_sessions_expired(client, tmp_path):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    with c.app.state.session_factory() as db:
        row = CommsSession(status="waiting", map_name="de_nuke", started_at=datetime.utcnow(),
                           payload=json.dumps(_session(datetime.utcnow())), folder=str(tmp_path),
                           created_at=datetime.utcnow() - timedelta(hours=49))
        db.add(row)
        db.commit()
        sid = row.id
    got = [r for r in c.get("/api/integrations/comms").json()["sessions"] if r["id"] == sid][0]
    assert got["status"] == "expired" and got["error"]
    with c.app.state.session_factory() as db:
        assert db.get(CommsSession, sid).status == "waiting"  # le GET n'écrit rien


def _twin(db, m, created_at):
    """Copie du match (autre démo, mêmes carte et score, sans rounds), démo arrivée à `created_at`."""
    from app.storage.models import Demo
    d = Demo(path="x", file_name="twin.dem", size=1, sha256=f"twin{created_at.timestamp()}", status="ready",
             created_at=created_at)
    db.add(d)
    db.flush()
    t = Match(**{c.name: getattr(m, c.name) for c in Match.__table__.columns if c.name not in ("id", "demo_id")},
              demo_id=d.id)
    db.add(t)
    db.flush()
    return t


def _imported(client):
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    return c, _match_facts(c)


def test_find_match_prefers_the_closest_demo_after_the_start(client):  # noqa: F811
    c, (m, players, rounds) = _imported(client)
    started = datetime(2026, 10, 24, 19, 30)
    s = {"started_at": started.isoformat(), "map": "de_nuke", "score": [m["score_a"], m["score_b"]], "rounds": []}
    with c.app.state.session_factory() as db:
        orig = db.get(Match, m["id"])
        orig.demo.created_at = started + timedelta(minutes=40)
        twin = _twin(db, orig, started + timedelta(minutes=5))
        db.commit()
        assert comms.find_match(db, s).id == twin.id  # le plus proche après le début
        twin.demo.created_at = started - timedelta(minutes=30)  # prac d'avant : la démo existait avant l'enregistrement
        db.commit()
        assert comms.find_match(db, s).id == orig.id
        twin.demo.created_at = started - timedelta(minutes=5)  # simple décalage d'horloge : accepté, écart compté pour 0
        db.commit()
        assert comms.find_match(db, s).id == twin.id
        db.add(CommsSession(status="attached", map_name="de_nuke", started_at=started, payload="{}", folder="x",
                            match_id=twin.id))
        db.commit()
        assert comms.find_match(db, s).id == orig.id  # déjà rattaché : ignoré


def test_find_match_drops_incoherent_rounds(client):  # noqa: F811
    c, (m, players, rounds) = _imported(client)
    started = datetime(2026, 10, 24, 19, 30)
    with c.app.state.session_factory() as db:
        db.get(Match, m["id"]).demo.created_at = started + timedelta(minutes=40)
        db.commit()
        good = [{"n": n, "live_at": (started + timedelta(seconds=30 + t / m["tickrate"])).isoformat()}
                for n, t in sorted(rounds.items())[:6]]
        s = {"started_at": started.isoformat(), "map": "de_nuke", "score": None, "rounds": good}
        assert comms.find_match(db, s).id == m["id"]
        bad = [{**r, "live_at": (datetime.fromisoformat(r["live_at"]) + timedelta(seconds=40 * i)).isoformat()}
               for i, r in enumerate(good)]  # décalages qui dérivent : pas le même match
        assert comms.find_match(db, {**s, "rounds": bad}) is None
        assert comms.find_match(db, {**s, "rounds": bad[:2]}) is not None  # moins de 3 rounds : pas de contrôle


def test_settle_expires_and_removes_the_session_folder(client, tmp_path):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    folder = tmp_path / "old"
    folder.mkdir()
    (folder / "t1.ogg").write_bytes(b"OggS")
    with c.app.state.session_factory() as db:
        row = CommsSession(status="waiting", map_name="de_nuke", started_at=datetime.utcnow(),
                           payload=json.dumps(_session(datetime.utcnow())), folder=str(folder),
                           created_at=datetime.utcnow() - timedelta(hours=49))
        db.add(row)
        db.commit()
        sid = row.id
    comms.settle(c.app.state, sid)
    with c.app.state.session_factory() as db:
        assert db.get(CommsSession, sid).status == "expired"
    assert not folder.exists()


def test_settle_puts_files_back_when_commit_fails(client, tmp_path, monkeypatch):  # noqa: F811
    c, _ = client
    c.post("/api/auth/setup", json=OWNER)
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    started = datetime.utcnow() - timedelta(minutes=5)
    folder = tmp_path / "s4"
    folder.mkdir()
    (folder / "t1.ogg").write_bytes(b"OggS-piste")
    s = comms.clean_session(_session(started), {"t1.ogg"})
    with c.app.state.session_factory() as db:
        row = CommsSession(status="waiting", recorder_steamid=None, map_name="de_nuke", started_at=started,
                           payload=json.dumps(s), folder=str(folder))
        db.add(row)
        db.commit()
        sid = row.id
    real_attach = comms.attach

    def attach_then_break(db, row, m, audio_dir):
        made = real_attach(db, row, m, audio_dir)
        commit = db.commit

        def boom():
            db.commit = commit  # le commit suivant (erreur enregistrée) passe
            raise RuntimeError("disque plein")
        db.commit = boom
        return made

    monkeypatch.setattr(comms, "attach", attach_then_break)
    comms.settle(c.app.state, sid)
    audio = c.app.state.settings.data_dir / "audio"
    assert (folder / "t1.ogg").read_bytes() == b"OggS-piste"  # revenu dans la session
    assert not list(audio.glob("*-comms*"))
    with c.app.state.session_factory() as db:
        got = db.get(CommsSession, sid)
        assert got.status == "waiting" and got.error == "Rattachement impossible, nouvel essai au prochain import"
        assert db.query(MatchAudio).count() == 0
    monkeypatch.setattr(comms, "attach", real_attach)
    comms.settle(c.app.state, sid)  # le prochain essai rattache bien
    with c.app.state.session_factory() as db:
        got = db.get(CommsSession, sid)
        assert got.status == "attached" and got.error is None
        assert db.query(MatchAudio).count() == 1
    assert not folder.exists()
