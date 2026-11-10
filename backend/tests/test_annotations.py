# backend/tests/test_annotations.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_annotations_roundtrip(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    mid = c.get("/api/matches").json()[0]["id"]
    rounds = c.get(f"/api/matches/{mid}").json()["rounds"]
    rid = rounds[4]["id"]
    assert c.get(f"/api/rounds/{rid}/annotations").json() == {"shapes": [], "note": ""}
    shape = {"id": "a1", "tool": "arrow", "color": "#ff0000", "width": 3, "level": "upper",
             "points": [[100, 200], [300.456, 400]], "from_tick": 1000, "to_tick": 1320}
    saved = c.put(f"/api/rounds/{rid}/annotations", json={"shapes": [shape], "note": "rotation B trop tôt"}).json()
    assert saved["shapes"][0]["points"][1] == [300.5, 400.0] and saved["note"] == "rotation B trop tôt"
    assert c.get(f"/api/rounds/{rid}/annotations").json() == saved
    assert c.get(f"/api/matches/{mid}/annotations").json() == [rounds[4]["number"]]
    assert c.put(f"/api/rounds/{rid}/annotations", json={"shapes": [{"tool": "laser", "points": [[1, 1]]}]}).status_code == 400
    assert c.put(f"/api/rounds/{rid}/annotations", json={"shapes": [{"tool": "pen", "points": []}]}).status_code == 400
    # survit à une ré-analyse
    demo_id = c.get("/api/demos").json()[0]["id"]
    c.post(f"/api/demos/{demo_id}/reparse")
    wait_ready(c)
    mid2 = c.get("/api/matches").json()[0]["id"]
    rid2 = c.get(f"/api/matches/{mid2}").json()["rounds"][4]["id"]
    assert c.get(f"/api/rounds/{rid2}/annotations").json()["note"] == "rotation B trop tôt"
    # vider supprime l'entrée
    c.put(f"/api/rounds/{rid2}/annotations", json={"shapes": [], "note": " "})
    assert c.get(f"/api/matches/{mid2}/annotations").json() == []
