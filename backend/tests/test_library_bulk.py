# backend/tests/test_library_bulk.py
"""Bibliothèque : organisation de plusieurs matchs d'un coup ; playlist à partir de matchs entiers."""
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_bulk_labels_and_match_playlist(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    m = c.get("/api/matches").json()[0]
    assert c.post("/api/matches/labels/bulk", json={"ids": []}).status_code == 400
    r = c.post("/api/matches/labels/bulk", json={"ids": [m["id"]], "folder": "Scrims", "tags_add": ["anti-eco", "b"]}).json()
    assert r["updated"] == 1
    lab = c.get("/api/matches").json()[0]["labels"]
    assert lab["folder"] == "Scrims" and lab["tags"] == ["anti-eco", "b"]
    c.post("/api/matches/labels/bulk", json={"ids": [m["id"]], "tags_remove": ["b"], "event": "Major"})
    lab = c.get("/api/matches").json()[0]["labels"]
    assert lab["folder"] == "Scrims" and lab["event"] == "Major" and lab["tags"] == ["anti-eco"]
    # filtre équipe de la bibliothèque
    faze = next(t for t in c.get("/api/teams").json() if t["name"] == "FaZe")
    assert len(c.get(f"/api/matches?team={faze['id']}").json()) == 1
    assert c.get("/api/matches?team=999999").json() == []
    # playlist depuis un match entier
    p = c.post("/api/playlists", json={"name": "Tout le match"}).json()
    added = c.post(f"/api/playlists/{p['id']}/items", json={"matches": [m["id"]]}).json()
    assert added["added"] == 23 and added["count"] == 23
    assert c.post(f"/api/playlists/{p['id']}/items", json={"matches": [999999]}).status_code == 404


def test_playlist_folders_favorites_tags(client):
    c, _ = client
    p = c.post("/api/playlists", json={"name": "Retakes", "folder": "Défense", "tags": ["b", "retake"]}).json()
    assert p["folder"] == "Défense" and p["tags"] == ["b", "retake"] and p["favorite"] is False and p["author"] is None
    p = c.patch(f"/api/playlists/{p['id']}", json={"favorite": True, "folder": ""}).json()
    assert p["favorite"] is True and p["folder"] == ""
    assert c.get("/api/playlists").json()[0]["favorite"] is True
    assert c.get(f"/api/playlists/{p['id']}").json()["tags"] == ["b", "retake"]


def test_demo_download(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    d = c.get("/api/demos").json()[0]
    r = c.get(f"/api/demos/{d['id']}/file")
    assert r.status_code == 200 and r.content == b"x" * 10 and "nuke.dem" in r.headers.get("content-disposition", "")
    assert c.get("/api/demos/999999/file").status_code == 404
