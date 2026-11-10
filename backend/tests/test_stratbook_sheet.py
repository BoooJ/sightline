# backend/tests/test_stratbook_sheet.py
from app.stratbook_import import import_data
from tests.test_api import client  # noqa: F401  (fixture)


def test_import_is_idempotent_and_reports_bad_items(client):
    c, _ = client
    data = {
        "strats": [
            {"name": "HOTU", "map": "de_dust2", "side": "CT", "type": "setup", "category": "pistol", "status": "ready",
             "roles": [{"player": "LDA", "call": "S1 peek long"}], "links": [{"url": "https://www.cs2lens.com/x", "label": "CS2 Lens"}]},
            {"name": "Sans camp", "map": "de_dust2", "side": "X"},
            None,  # élément mal formé : signalé, l'import continue
        ],
        "playbook": [{"kind": "codeword", "title": "Doublette", "body": "deux flashs"}, {"kind": "?", "title": "x"}],
    }
    first = import_data(c.app.state.session_factory, data)
    assert (first["strats_created"], first["playbook_created"], len(first["errors"])) == (1, 1, 3)
    again = import_data(c.app.state.session_factory, data)
    assert (again["strats_created"], again["strats_skipped"], again["playbook_skipped"]) == (0, 1, 1)
    s = c.get("/api/strats?map=de_dust2").json()
    assert len(s) == 1 and c.get(f"/api/strats/{s[0]['id']}").json()["roles"][0]["player"] == "LDA"

BASE = {"name": "HOTU", "map": "de_dust2", "side": "CT", "type": "setup"}


def test_strat_roles_status_category_links(client):
    c, _ = client
    s = c.post("/api/strats", json={
        **BASE, "status": "ready", "category": "pistol",
        "roles": [{"player": "LDA", "call": "S1 peek long et tient le sas"}, {"player": "", "call": ""}, {"player": "Nowx", "call": "x" * 900}],
        "links": [{"url": "https://pracc.com/replay/2d?matchUids=abc#selectedRound=1", "label": "PRACC"}],
    }).json()
    assert s["status"] == "ready" and s["category"] == "pistol"
    assert [r["player"] for r in s["roles"]] == ["LDA", "Nowx"] and len(s["roles"][1]["call"]) == 600  # vide retiré, coupé à 600
    assert s["links"][0]["label"] == "PRACC"
    summary = c.get("/api/strats?map=de_dust2").json()[0]
    assert summary["status"] == "ready" and summary["category"] == "pistol" and "roles" not in summary
    assert c.patch(f"/api/strats/{s['id']}", json={"status": "wip", "category": None}).json()["status"] == "wip"
    assert c.post("/api/strats", json={**BASE, "status": "fini"}).status_code == 400
    assert c.post("/api/strats", json={**BASE, "category": "inconnue"}).status_code == 400
    assert c.post("/api/strats", json={**BASE, "links": [{"url": "javascript:alert(1)"}]}).status_code == 400
    assert c.post("/api/strats", json={**BASE, "roles": [{"player": "a"}] * 11}).status_code == 400
    plain = c.post("/api/strats", json=BASE).json()
    assert plain["roles"] == [] and plain["links"] == [] and plain["status"] is None


def test_playbook_crud(client):
    c, _ = client
    e = c.post("/api/playbook", json={"kind": "codeword", "title": "Limace", "body": "exec très lente"}).json()
    assert e["kind"] == "codeword" and e["map"] is None
    c.post("/api/playbook", json={"kind": "roles", "title": "Dust 2 · T", "body": "Outside B : Nowx", "map": "de_dust2", "side": "T"})
    assert [x["title"] for x in c.get("/api/playbook").json()] == ["Limace", "Dust 2 · T"]  # rangé par genre
    assert c.patch(f"/api/playbook/{e['id']}", json={"body": "exec lente", "link": "https://youtu.be/x"}).json()["link"] == "https://youtu.be/x"
    assert c.post("/api/playbook", json={"kind": "autre", "title": "x"}).status_code == 400
    assert c.post("/api/playbook", json={"kind": "note", "title": " "}).status_code == 400
    assert c.post("/api/playbook", json={"kind": "note", "title": "x", "position": 10 ** 20}).status_code == 400
    assert c.patch(f"/api/playbook/{e['id']}", json={"link": "ftp://x"}).status_code == 400
    assert c.delete(f"/api/playbook/{e['id']}").json() == {"ok": True}
    assert c.delete(f"/api/playbook/{e['id']}").status_code == 404
