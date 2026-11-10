# backend/tests/test_audio.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def _upload(c, uid, name, data, kind="audio"):
    assert c.post("/api/uploads", json={"id": uid, "name": name, "size": len(data), "kind": kind}).status_code == 200
    c.put(f"/api/uploads/{uid}?offset=0", content=data)


def test_audio_tracks(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    mid = c.get("/api/matches").json()[0]["id"]
    bad = c.post("/api/uploads", json={"id": "aaaaaaaaaaaa", "name": "comms.exe", "size": 3, "kind": "audio"})
    assert bad.status_code == 400
    data = bytes(range(256)) * 100
    _upload(c, "audio00000001", "comms faze.mp3", data)
    tr = c.post(f"/api/matches/{mid}/audio", json={"upload_id": "audio00000001", "label": "FaZe", "steamid": "7656"}).json()
    assert tr["label"] == "FaZe" and tr["offset_s"] == 0 and tr["steamid"] == "7656"
    assert c.patch(f"/api/audio/{tr['id']}", json={"steamid": ""}).json()["steamid"] is None
    # un upload de démo ne peut pas devenir une piste audio
    _upload(c, "demo000000001", "x.dem", b"abc", kind="demo")
    assert c.post(f"/api/matches/{mid}/audio", json={"upload_id": "demo000000001"}).status_code == 400
    assert c.patch(f"/api/audio/{tr['id']}", json={"offset_s": -12.3456}).json()["offset_s"] == -12.346
    f = c.get(tr["url"])
    assert f.status_code == 200 and f.content == data and f.headers["content-type"] == "audio/mpeg"
    part = c.get(tr["url"], headers={"Range": "bytes=100-199"})
    assert part.status_code == 206 and part.content == data[100:200]
    assert len(c.get(f"/api/matches/{mid}/audio").json()) == 1
    assert c.delete(f"/api/audio/{tr['id']}").json()["ok"]
    assert c.get(f"/api/matches/{mid}/audio").json() == []
