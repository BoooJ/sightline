# backend/tests/test_analysis.py
import io

from app.stats.analysis import win_prob_t
from tests.test_api import client, wait_ready  # noqa: F401 — fixture partagée


def test_win_prob_model_ordering():
    base = win_prob_t(5, 5, False, 100, 0, 0)
    assert 0.4 < base < 0.55
    assert win_prob_t(5, 4, False, 100, 0, 0) > base > win_prob_t(4, 5, False, 100, 0, 0)
    assert win_prob_t(5, 5, True, 30, 0, 0) > base  # bombe posée
    assert win_prob_t(5, 5, False, 100, 0, -3) < 0.2  # éco contre achat complet
    assert win_prob_t(3, 0, False, 50, 0, 0) == 1.0 and win_prob_t(0, 2, False, 50, 0, 0) == 0.0
    assert win_prob_t(0, 2, True, 0, 5, 0) < win_prob_t(0, 2, True, 0, 38, 0)  # désamorçage de moins en moins sûr
    assert win_prob_t(5, 5, False, 5, 0, 0) < base  # fin du temps sans pose
    assert win_prob_t(5, 5, False, 100, 0, 0, hp_t=100, hp_ct=50) > base > win_prob_t(5, 5, False, 100, 0, 0, hp_t=50, hp_ct=100)  # PV restants


def _import(c):
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    return wait_ready(c)[0]["match_id"]


def test_match_analysis_api(client):  # noqa: F811
    c, _ = client
    mid = _import(c)
    a = c.get(f"/api/matches/{mid}/analysis").json()
    assert len(a["rounds"]) == 23 and len(a["players"]) == 10
    for r in a["rounds"]:
        assert all(0.0 <= p <= 1.0 for _, p in r["curve"])
        if r["winner_side"]:
            assert r["curve"][-1][1] == (1.0 if r["winner_side"] == "CT" else 0.0)
    kills = [e for r in a["rounds"] for e in r["events"] if e["type"] == "kill"]
    assert len(a["deaths"]) == len(kills) > 100
    assert sum(p["impact"] for p in a["players"]) != 0
    assert 0 < len(a["key_moments"]) <= 10 and a["key_moments"][0]["swing"] >= a["key_moments"][-1]["swing"]
    assert all(set(d["reasons"]) <= set(a["reasons"]) for d in a["deaths"])
    assert any(d["place"] for d in a["deaths"])  # lieux des kills
    # rounds avec images (fixture : 1 à 3) : contexte de la mort calculé
    early = [d for d in a["deaths"] if d["round"] <= 3]
    assert early and all(d["equip"] is not None for d in early)
    assert all(p["aim"] and p["aim"]["shots"] > 0 for p in a["players"])
    assert set(a["advantages"]) == {str(t) for t in {p["team_id"] for p in a["players"]}}
    assert c.get("/api/matches/999/analysis").status_code == 404
    ex = c.get("/api/players/extras").json()
    assert len(ex) == 10 and all("impact" in v and v["aim"] for v in ex.values())
    assert c.get("/api/players/extras?map=de_dust2").json() == {}


def test_callouts(client):  # noqa: F811
    c, _ = client
    _import(c)
    co = c.get("/api/callouts?map=de_nuke").json()
    places = {p["place"]: p for p in co["places"]}
    assert "Outside" in places and places["Outside"]["count"] > 0 and places["Outside"]["pos"]
    assert c.put("/api/callouts", json={"map": "de_nuke", "place": "Hut", "label": "Cabane"}).status_code == 200
    assert c.get("/api/callouts?map=de_nuke").json()["labels"] == {"Hut": "Cabane"}
    c.put("/api/callouts", json={"map": "de_nuke", "place": "Hut", "label": "Hutte"})
    assert c.get("/api/callouts?map=de_nuke").json()["labels"] == {"Hut": "Hutte"}
    c.put("/api/callouts", json={"map": "de_nuke", "place": "Hut", "label": ""})
    assert c.get("/api/callouts?map=de_nuke").json()["labels"] == {}
    assert c.put("/api/callouts", json={"map": "", "place": "Hut", "label": "x"}).status_code == 400


def test_highlights(client):  # noqa: F811
    c, _ = client
    mid = _import(c)
    d = c.get("/api/highlights").json()
    assert d["total"] > 0 and all(h["match_id"] == mid for h in d["items"])
    assert [h["score"] for h in d["items"]] == sorted((h["score"] for h in d["items"]), reverse=True)
    kinds = {h["type"] for h in d["items"]}
    assert kinds & {"3k", "4k", "ace"}
    one = c.get("/api/highlights?type=3k").json()["items"]
    assert one and all(h["type"] == "3k" and (h["detail"] == "" or h["detail"].startswith("en ")) for h in one)
    p = one[0]["player"]
    assert all(h["player"] == p for h in c.get(f"/api/highlights?player={p}").json()["items"])
    assert c.get("/api/highlights?map=de_dust2").json()["total"] == 0
    assert "ace" in c.get("/api/highlights/types").json()


def test_calendar(client):  # noqa: F811
    from datetime import date
    c, _ = client
    mid = _import(c)
    team = c.get(f"/api/matches/{mid}").json()["team_a"]["name"]
    today = date.today().isoformat()
    e = c.post("/api/calendar", json={"title": "Scrim", "kind": "scrim", "opponent": team.upper(), "starts_at": f"{today}T20:00",
                                      "maps": ["de_nuke"]}).json()
    assert e["kind"] == "scrim" and [m["id"] for m in e["matches"]] == [mid] and not e["matches"][0]["manual"]
    other = c.post("/api/calendar", json={"title": "Officiel", "opponent": "Inconnus", "starts_at": "2030-01-05T19:00"}).json()
    assert other["matches"] == []
    linked = c.patch(f"/api/calendar/{other['id']}", json={"match_ids": [mid]}).json()
    assert linked["matches"][0]["manual"] is True
    listed = c.get("/api/calendar?start=2020-01-01&end=2031-01-01").json()
    assert [x["title"] for x in listed] == ["Scrim", "Officiel"]
    assert c.get(f"/api/calendar?start={today}&end=2029-01-01").json()[0]["title"] == "Scrim"
    assert c.post("/api/calendar", json={"title": "", "starts_at": today}).status_code == 400
    assert c.post("/api/calendar", json={"title": "x", "kind": "zzz", "starts_at": today}).status_code == 400
    assert c.delete(f"/api/calendar/{other['id']}").json()["ok"]
    assert c.delete(f"/api/calendar/{other['id']}").status_code == 404
    # heures en UTC à la sortie : avec fuseau (site, PRACC) ou sans (heure de Paris, anciens clients)
    utc = c.post("/api/calendar", json={"title": "ESEA", "starts_at": "2026-10-28T20:30:00+01:00"}).json()
    assert utc["starts_at"] == "2026-10-28T19:30:00Z"
    assert c.post("/api/calendar", json={"title": "Été", "starts_at": "2026-07-01T20:00"}).json()["starts_at"] == "2026-07-01T18:00:00Z"
    assert c.post("/api/calendar", json={"title": "Site", "starts_at": "2026-10-28T23:00:00.000Z"}).json()["starts_at"] == "2026-10-28T23:00:00Z"


def test_live_session(client):  # noqa: F811
    c, _ = client
    s = c.post("/api/live", json={"match_id": 1, "round": 3, "tick": 100}).json()
    code, key = s["code"], s["key"]
    assert len(code) == 6 and s["round"] == 3 and s["viewers"] == 0
    assert c.post(f"/api/live/{code}/state", json={"key": "faux", "tick": 5}).status_code == 403
    r = c.post(f"/api/live/{code}/state", json={"key": key, "tick": 640, "playing": True, "speed": 2, "ignored": 1}).json()
    assert r["version"] == 1
    st = c.get(f"/api/live/{code.lower()}").json()
    assert st["tick"] == 640 and st["playing"] is True and st["round"] == 3 and "ignored" not in st and "key" not in st
    assert c.delete(f"/api/live/{code}?key=faux").status_code == 403
    assert c.delete(f"/api/live/{code}?key={key}").json()["ok"]
    assert c.get(f"/api/live/{code}").status_code == 404


def test_map_pool(client):  # noqa: F811
    c, _ = client
    names = [m["name"] for m in c.get("/api/maps").json()]
    assert "de_train" not in names and "de_overpass" not in names and "de_mirage" in names and "de_cache" in names
    assert len(names) == 7  # pool actuel ; aucune carte hors pool sans match ni stratégie
    everything = {m["name"]: m["active_duty"] for m in c.get("/api/maps?all=true").json()}
    assert everything["de_train"] is False and everything["de_nuke"] is True
    # une carte sortie du pool reste listée dès qu'il y a une stratégie (ou un match) dessus
    c.post("/api/strats", json={"name": "Vieux split", "map": "de_train", "side": "T"})
    assert "de_train" in [m["name"] for m in c.get("/api/maps").json()]
    assert c.get("/api/maps/de_train").status_code == 200


def test_rounds_tactic_filter(client):  # noqa: F811
    c, _ = client
    mid = _import(c)
    m = c.get(f"/api/matches/{mid}").json()
    # la fixture n'a des positions que pour les rounds 1 à 3 : une équipe y est T, l'autre CT
    pbs = {t["id"]: c.get(f"/api/scouting/teams/{t['id']}/playbook?map=de_nuke").json() for t in (m["team_a"], m["team_b"])}
    team, pb = next((t, p) for t, p in pbs.items() if p["t"]["categories"])
    cat = pb["t"]["categories"][0]
    res = c.get(f"/api/rounds/search?team={team}&map=de_nuke&tactic=t:{cat['key']}").json()
    assert res["total"] == cat["n"] and all(r["pov_side"] == "T" for r in res["rounds"])
    ct_team, ct_pb = next((t, p) for t, p in pbs.items() if p["ct"]["setups"])
    setup = ct_pb["ct"]["setups"][0]
    res = c.get("/api/rounds/search", params={"team": ct_team, "map": "de_nuke", "tactic": f"ct:{setup['key']}"}).json()
    assert res["total"] == setup["n"]
    assert c.get("/api/rounds/search?tactic=t:execute").status_code == 400
    assert c.get(f"/api/rounds/search?team={team}&map=de_nuke&tactic=zz").status_code == 400


def test_bookmarks(client):  # noqa: F811
    c, _ = client
    mid = _import(c)
    b = c.post("/api/bookmarks", json={"match_id": mid, "round_number": 4, "tick": 12345, "label": "Retake raté"}).json()
    assert b["label"] == "Retake raté" and b["match"]["id"] == mid
    c.post("/api/bookmarks", json={"match_id": mid, "round_number": 7, "tick": 222})
    assert [x["round_number"] for x in c.get("/api/bookmarks").json()] == [7, 4]
    assert len(c.get(f"/api/bookmarks?match={mid}").json()) == 2
    assert c.patch(f"/api/bookmarks/{b['id']}", json={"label": "Retake B"}).json()["label"] == "Retake B"
    assert c.delete(f"/api/bookmarks/{b['id']}").json()["ok"]
    assert len(c.get("/api/bookmarks").json()) == 1
    assert c.post("/api/bookmarks", json={"match_id": 999, "round_number": 1, "tick": 1}).status_code == 404
    assert c.post("/api/bookmarks", json={"match_id": mid}).status_code == 400


def test_custom_callouts(client):  # noqa: F811
    c, _ = client
    r = c.post("/api/callouts/custom", json={"map": "de_cache", "label": "Banane bas", "pos": [100.5, -200, 1600]}).json()
    assert r["label"] == "Banane bas" and r["pos"] == [100, -200, 1600]
    co = c.get("/api/callouts?map=de_cache").json()
    assert co["custom"] == [r] and co["labels"] == {} and co["places"] == []
    assert c.patch(f"/api/callouts/custom/{r['id']}", json={"label": "Banane", "pos": [110, -190, 1600]}).json()["pos"] == [110, -190, 1600]
    assert c.post("/api/callouts/custom", json={"map": "de_cache", "label": "", "pos": [0, 0, 0]}).status_code == 400
    assert c.post("/api/callouts/custom", json={"map": "de_cache", "label": "x", "pos": [0, 0]}).status_code == 400
    assert c.delete(f"/api/callouts/custom/{r['id']}").json()["ok"]
    assert c.get("/api/callouts?map=de_cache").json()["custom"] == []
