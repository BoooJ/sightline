# backend/tests/test_rounds_playlists.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def _ready(c):
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    return c.get("/api/matches").json()[0]


def test_round_search(client):
    c, _ = client
    m = _ready(c)
    allr = c.get("/api/rounds/search").json()
    assert allr["total"] == 23 and len(allr["rounds"]) == 23
    faze = next(t for t in c.get("/api/teams").json() if t["name"] == "FaZe")
    won = c.get(f"/api/rounds/search?team={faze['id']}&result=won").json()
    lost = c.get(f"/api/rounds/search?team={faze['id']}&result=lost").json()
    assert won["total"] == 10 and lost["total"] == 13
    ct = c.get(f"/api/rounds/search?team={faze['id']}&side=CT").json()
    t = c.get(f"/api/rounds/search?team={faze['id']}&side=T").json()
    assert ct["total"] + t["total"] == 23 and all(r["pov_side"] == "CT" for r in ct["rounds"])
    pist = c.get("/api/rounds/search?pistol=true").json()
    assert sorted(r["number"] for r in pist["rounds"]) == [1, 13]
    planted = c.get("/api/rounds/search?bomb=planted").json()["total"]
    assert planted + c.get("/api/rounds/search?bomb=none").json()["total"] == 23 and planted == 10
    a = c.get("/api/rounds/search?bomb=A").json()["total"]
    b = c.get("/api/rounds/search?bomb=B").json()["total"]
    assert a + b == planted
    eco = c.get(f"/api/rounds/search?team={faze['id']}&buy=eco,force").json()
    assert all(r[f"{r['pov_side'].lower()}_buy_type"] in ("eco", "force") for r in eco["rounds"])
    assert c.get("/api/rounds/search?map=de_dust2").json()["total"] == 0
    assert c.get("/api/rounds/search?result=maybe").status_code == 400
    assert c.get(f"/api/rounds/search?match={m['id']}&half=second").json()["total"] == 11


def test_playlists_crud(client):
    c, _ = client
    _ready(c)
    rounds = c.get("/api/rounds/search").json()["rounds"]
    p = c.post("/api/playlists", json={"name": "Retakes B"}).json()
    assert c.post("/api/playlists", json={"name": " "}).status_code == 400
    ids = [r["id"] for r in rounds[:4]]
    res = c.post(f"/api/playlists/{p['id']}/items", json={"rounds": ids + ids[:1]}).json()
    assert res["added"] == 4 and res["count"] == 4
    d = c.get(f"/api/playlists/{p['id']}").json()
    assert [i["round"]["id"] for i in d["items"]] == ids
    last = d["items"][-1]
    d = c.patch(f"/api/playlists/{p['id']}/items/{last['id']}", json={"position": 0, "note": "à revoir"}).json()
    assert d["items"][0]["id"] == last["id"] and d["items"][0]["note"] == "à revoir"
    assert [i["position"] for i in d["items"]] == [0, 1, 2, 3]
    d = c.delete(f"/api/playlists/{p['id']}/items/{d['items'][1]['id']}").json()
    assert len(d["items"]) == 3 and [i["position"] for i in d["items"]] == [0, 1, 2]
    assert c.patch(f"/api/playlists/{p['id']}", json={"name": "Retakes"}).json()["name"] == "Retakes"
    assert c.get("/api/playlists").json()[0]["count"] == 3
    # survit à une ré-analyse (les rounds sont recréés)
    demo_id = c.get("/api/demos").json()[0]["id"]
    c.post(f"/api/demos/{demo_id}/reparse")
    wait_ready(c)
    d = c.get(f"/api/playlists/{p['id']}").json()
    assert all(i["round"] is not None for i in d["items"])
    assert c.delete(f"/api/playlists/{p['id']}").json()["ok"]
    assert c.get(f"/api/playlists/{p['id']}").status_code == 404


def test_quick_filters_and_weapon(client):
    c, _ = client
    m = _ready(c)
    faze = next(t for t in c.get("/api/teams").json() if t["name"] == "FaZe")["id"]
    q = lambda qs: c.get(f"/api/rounds/search?{qs}").json()  # noqa: E731
    assert sorted(r["number"] for r in q("quick=second")["rounds"]) == [2, 14]
    won, lost = q(f"team={faze}&quick=opening_won")["total"], q(f"team={faze}&quick=opening_lost")["total"]
    assert won + lost == 23 and won == 10  # cf. stats : FaZe gagne 10 duels d'ouverture
    assert all(r["opening_side"] == r["pov_side"] for r in q(f"team={faze}&quick=opening_won")["rounds"])
    cl = q(f"team={faze}&quick=clutch_won")
    assert all(r["pov_side"] in r["clutch"] and r["winner_side"] == r["pov_side"] for r in cl["rounds"])
    eco = q(f"team={faze}&quick=eco_won")
    assert all(r[f"{r['pov_side'].lower()}_buy_type"] in ("eco", "semi") and r["winner_side"] == r["pov_side"] for r in eco["rounds"])
    assert q("quick=commented")["total"] == 0
    rid = q("")["rounds"][0]["id"]
    c.post(f"/api/matches/{m['id']}/comments", json={"round_number": q("")["rounds"][0]["number"], "body": "x"})
    assert q("quick=commented")["total"] == 1
    c.put(f"/api/rounds/{rid}/annotations", json={"shapes": [], "note": "à revoir"})
    assert q("quick=annotated")["total"] == 1
    assert c.get("/api/rounds/search?quick=magie").status_code == 400
    weapons = c.get("/api/rounds/weapons?map=de_nuke").json()
    assert weapons[0]["kills"] >= weapons[-1]["kills"] and any(w["weapon"] == "awp" for w in weapons)
    awp = q("weapon=awp")
    assert 0 < awp["total"] < 23
    awp_faze = q(f"team={faze}&weapon=awp")["total"]
    assert awp_faze <= awp["total"]
