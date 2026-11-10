# backend/tests/test_prep.py
"""Match Prep : widgets, templates (partagés / privés), rapports générés et figés, notes, suppression."""
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_match_prep(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    faze = next(t for t in c.get("/api/scouting/teams").json() if t["name"] == "FaZe")
    kinds = {w["type"] for w in c.get("/api/prep/widgets").json()}
    assert {"overview", "reads", "pistols", "attack", "sites", "zones", "postplant", "defense", "utility", "players", "playbook", "notes"} <= kinds
    # template par défaut créé à la première visite
    tpls = c.get("/api/prep/templates").json()
    assert len(tpls) == 1 and tpls[0]["name"] == "Rapport standard" and tpls[0]["shared"] and len(tpls[0]["widgets"]) == 12
    # template personnalisé
    assert c.post("/api/prep/templates", json={"name": "Court", "widgets": [{"type": "nope"}]}).status_code == 400
    t = c.post("/api/prep/templates", json={"name": "Court", "widgets": [{"type": "reads"}, {"type": "notes", "text": "Rappels"}], "shared": False}).json()
    assert t["widgets"][1]["text"] == "Rappels" and t["shared"] is False
    t = c.patch(f"/api/prep/templates/{t['id']}", json={"name": "Court v2", "shared": True}).json()
    assert t["name"] == "Court v2" and t["shared"] is True
    assert len(c.get("/api/prep/templates").json()) == 2
    # rapport généré et figé
    assert c.post("/api/prep/reports", json={"team_id": faze["id"], "map": "nope", "template_id": t["id"]}).status_code == 400
    assert c.post("/api/prep/reports", json={"team_id": 999999, "map": "de_nuke", "template_id": t["id"]}).status_code == 404
    r = c.post("/api/prep/reports", json={"team_id": faze["id"], "map": "de_nuke", "template_id": t["id"]}).json()
    assert r["title"] == "FaZe · Nuke" and [w["type"] for w in r["content"]["widgets"]] == ["reads", "notes"]
    reads = r["content"]["widgets"][0]["data"]
    assert reads["matches"] == 1 and "takeaways" in reads and "counters" in reads
    assert r["content"]["widgets"][1]["data"]["text"] == "Rappels"
    full = c.post("/api/prep/reports", json={"team_id": faze["id"], "map": "de_nuke", "template_id": tpls[0]["id"], "title": "Prépa FaZe"}).json()
    types = [w["type"] for w in full["content"]["widgets"]]
    assert types == [w["type"] for w in tpls[0]["widgets"]]
    by = {w["type"]: w["data"] for w in full["content"]["widgets"]}
    assert by["overview"]["matches"] == 1 and by["players"]["players"] and "T" in by["utility"] and "categories" in by["playbook"]
    assert "engage_by_site" in by["attack"]   # prise des sites (rapports récents seulement)
    assert by["sites"]["total"]["rounds"] > 0 and set(by["sites"]["by_buy"]) <= {"pistol", "eco", "semi", "force", "full"}
    assert by["zones"]["T"]["rounds"] >= 0 and all("place" in z and "pct" in z for z in by["zones"]["T"]["zones"])
    assert by["postplant"]["t"]["plants"] >= by["postplant"]["t"]["post_plant_won"] and "retakes" in by["postplant"]["ct"]
    lst = c.get("/api/prep/reports").json()
    assert [x["id"] for x in lst] == [full["id"], r["id"]] and lst[0]["title"] == "Prépa FaZe" and lst[0]["widgets"] == types
    assert len(c.get(f"/api/prep/reports?team={faze['id']}").json()) == 2
    got = c.patch(f"/api/prep/reports/{r['id']}", json={"notes": "Attention au B rush"}).json()
    assert got["notes"] == "Attention au B rush"
    assert c.get(f"/api/prep/reports/{r['id']}").json()["notes"] == "Attention au B rush"
    assert c.delete(f"/api/prep/reports/{r['id']}").json()["ok"] and c.get(f"/api/prep/reports/{r['id']}").status_code == 404
    r2 = c.post("/api/prep/reports", json={"team_id": faze["id"], "map": "de_nuke", "template_id": t["id"]}).json()
    assert c.delete(f"/api/prep/templates/{t['id']}").json()["ok"]
    assert c.get(f"/api/prep/reports/{r2['id']}").status_code == 200  # le rapport (figé) survit au template
    assert c.get(f"/api/prep/reports/{full['id']}").json()["template_id"] == tpls[0]["id"]
