# backend/tests/test_strats.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_stratbook_crud(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    mid = c.get("/api/matches").json()[0]["id"]
    body = {
        "name": "Exécution B ramp", "map": "de_nuke", "side": "T", "type": "execute", "description": "Smoke ramp + flash",
        "tags": ["pistol", "pistol", " "],
        "positions": [{"name": "Maka", "role": "entry", "pos": [100, 200, -400], "yaw": 90}],
        "grenades": [{"type": "smoke", "player": "Maka", "throw": [1, 2, 3], "land": [4, 5, 6],
                      "setpos": "setpos 1.00 2.00 3.00;setang -5.00 90.00 0", "timing_s": 12.5, "trajectory": [[1, 2, 3], [4, 5, 6]]}],
        "shapes": [{"id": "a", "tool": "arrow", "color": "#fff", "width": 3, "level": "upper", "points": [[1, 1], [9, 9]]}],
        "source": {"match_id": mid, "round_number": 4, "tick": 5000},
    }
    s = c.post("/api/strats", json=body).json()
    assert s["tags"] == ["pistol"] and s["counts"] == {"positions": 1, "grenades": 1, "shapes": 1}
    assert s["source"]["round_number"] == 4
    assert c.post("/api/strats", json={**body, "side": "X"}).status_code == 400
    assert c.post("/api/strats", json={**body, "grenades": [{"type": "nuke"}]}).status_code == 400
    assert c.post("/api/strats", json={**body, "grenades": [{"type": "smoke", "setpos": "quit"}]}).status_code == 400
    assert c.post("/api/strats", json={**body, "positions": [body["positions"][0]] * 6}).status_code == 400
    assert c.post("/api/strats", json={**body, "source": {"match_id": 999, "round_number": 1}}).status_code == 400
    lst = c.get("/api/strats?map=de_nuke&side=T").json()
    assert len(lst) == 1 and "positions" not in lst[0]
    assert c.get("/api/strats?map=de_dust2").json() == []
    up = c.patch(f"/api/strats/{s['id']}", json={"name": "Exec B", "description": "v2"}).json()
    assert up["name"] == "Exec B" and up["description"] == "v2" and up["positions"][0]["name"] == "Maka"
    g = c.post(f"/api/strats/{s['id']}/grenades", json={"type": "flash", "throw": [0, 0, 0], "land": [1, 1, 1]}).json()
    assert g["counts"]["grenades"] == 2
    assert c.delete(f"/api/strats/{s['id']}").json()["ok"]
    assert c.get(f"/api/strats/{s['id']}").status_code == 404
