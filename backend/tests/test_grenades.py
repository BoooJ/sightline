# backend/tests/test_grenades.py
import io

from app.stats.grenades import cluster
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_grenades_api(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    allg = c.get("/api/grenades?map=de_nuke").json()
    assert len(allg["throws"]) == 41
    smokes = c.get("/api/grenades?map=de_nuke&type=smoke").json()["throws"]
    assert len(smokes) == 11 and all(t["type"] == "smoke" for t in smokes)
    t0 = smokes[0]
    assert t0["setpos"].startswith("setpos ") and ";setang " in t0["setpos"]
    assert len(t0["trajectory"]) <= 25 and t0["land"] is not None
    ct = c.get("/api/grenades?map=de_nuke&side=CT").json()["throws"]
    t = c.get("/api/grenades?map=de_nuke&side=T").json()["throws"]
    assert len(ct) + len(t) == 41
    one = c.get(f"/api/grenades?map=de_nuke&player={t0['thrower']}").json()["throws"]
    assert one and all(x["thrower"] == t0["thrower"] for x in one)
    assert sum(lu["count"] for lu in allg["lineups"]) == len([x for x in allg["throws"] if x["land"]])
    assert c.get("/api/grenades?map=de_dust2").json()["throws"] == []
    assert c.get("/api/grenades?map=de_nuke&type=nuke").status_code == 400
    light = c.get("/api/grenades?map=de_nuke&throws=false").json()  # app mobile : lineups seuls
    assert light["throws"] == [] and light["lineups"] == allg["lineups"]


def test_cluster_groups_same_lineup():
    base = {"type": "smoke", "side": "T", "setpos": None, "trajectory": []}
    throws = [
        {**base, "id": 1, "thrower_name": "a", "throw": [0, 0, 0], "land": [1000, 0, 0]},
        {**base, "id": 2, "thrower_name": "b", "throw": [20, 10, 0], "land": [1080, 40, 0]},
        {**base, "id": 3, "thrower_name": "a", "throw": [0, 0, 0], "land": [1600, 0, 0]},   # autre arrivée
        {**base, "id": 4, "thrower_name": "a", "throw": [300, 0, 0], "land": [1000, 0, 0]},  # autre départ
        {**base, "id": 5, "thrower_name": "a", "throw": [0, 0, 0], "land": [1000, 0, 0], "type": "flash"},
    ]
    out = cluster(throws)
    assert out[0]["ids"] == [1, 2] and out[0]["players"] == ["a", "b"] and len(out) == 4
