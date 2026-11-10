# backend/tests/test_tactics.py
"""Playbook v2 : évaluation des conditions, CRUD des tactiques, détection sur la fixture."""
import io

import numpy as np
import pytest

from app.stats.playbook import DEFAULT_KINDS
from app.stats.tactics import RoundCtx, clean_definition, evaluate
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

SQUARE = [[0, 0], [100, 0], [100, 100], [0, 100]]


def _ctx(xs, ys, alive=None, grenades=(), plant=None, contact=None):
    n, k = np.asarray(xs).shape
    ticks = np.arange(n) * 64  # une trame par seconde à 64 ticks
    return RoundCtx(rate=64, t0=0, end_tick=int(ticks[-1]), ticks=ticks, X=np.asarray(xs, float), Y=np.asarray(ys, float),
                    Z=np.zeros((n, k)), alive=np.ones((n, k), bool) if alive is None else np.asarray(alive, bool), levels=["default"],
                    grenades=list(grenades), plant_s=plant[0] if plant else None, plant_site=plant[1] if plant else None, contact_s=contact)


def test_clean_definition():
    d = clean_definition({"conditions": [{"kind": "players_in_zone", "zone": SQUARE, "min_players": 9, "from_s": 10, "to_s": 40},
                                         {"kind": "utility_in_zone", "zone": SQUARE, "types": ["smoke", "bogus"], "min_count": 2},
                                         {"kind": "bomb_planted", "site": "A", "before_s": 60}, {"kind": "contact_before", "s": 20}]})
    assert d["conditions"][0]["min_players"] == 5 and d["conditions"][1]["types"] == ["smoke"] and d["conditions"][1]["position"] == "land"
    assert d["conditions"][2]["site"] == "A" and d["conditions"][3]["s"] == 20
    with pytest.raises(ValueError):
        clean_definition({"conditions": []})
    with pytest.raises(ValueError):
        clean_definition({"conditions": [{"kind": "players_in_zone", "zone": [[0, 0]]}]})
    with pytest.raises(ValueError):
        clean_definition({"conditions": [{"kind": "nope"}]})


def test_evaluate_conditions():
    # 2 joueurs : le premier entre dans la zone à 3 s, le second à 5 s
    xs = [[-50, -50], [-50, -50], [-50, -50], [50, -50], [50, -50], [50, 50], [50, 50]]
    ys = [[50, 50]] * 7
    ctx = _ctx(xs, ys)
    one = clean_definition({"conditions": [{"kind": "players_in_zone", "zone": SQUARE, "min_players": 1}]})
    two = clean_definition({"conditions": [{"kind": "players_in_zone", "zone": SQUARE, "min_players": 2}]})
    assert evaluate(one, ctx) == 3.0 and evaluate(two, ctx) == 5.0
    late = clean_definition({"conditions": [{"kind": "players_in_zone", "zone": SQUARE, "min_players": 2, "from_s": 0, "to_s": 4}]})
    assert evaluate(late, ctx) is None
    dead = _ctx(xs, ys, alive=[[1, 0]] * 7)
    assert evaluate(two, dead) is None
    # utilitaires : deux smokes dans la zone (atterrissage), la deuxième à 12 s
    g = [("smoke", 8.0, -200, -200, 10.0, 20, 20), ("smoke", 9.0, -200, -200, 12.0, 30, 30), ("flash", 1.0, 0, 0, 2.0, 40, 40)]
    ctx2 = _ctx(xs, ys, grenades=g, plant=(40.0, "A"), contact=15.0)
    util = clean_definition({"conditions": [{"kind": "utility_in_zone", "zone": SQUARE, "types": ["smoke"], "min_count": 2}]})
    assert evaluate(util, ctx2) == 12.0
    assert evaluate(clean_definition({"conditions": [{"kind": "utility_in_zone", "zone": SQUARE, "types": ["smoke"], "min_count": 3}]}), ctx2) is None
    assert evaluate(clean_definition({"conditions": [{"kind": "bomb_planted", "site": "A", "before_s": 60}]}), ctx2) == 40.0
    assert evaluate(clean_definition({"conditions": [{"kind": "bomb_planted", "site": "B"}]}), ctx2) is None
    assert evaluate(clean_definition({"conditions": [{"kind": "contact_before", "s": 20}]}), ctx2) == 15.0
    assert evaluate(clean_definition({"conditions": [{"kind": "no_contact_before", "s": 20}]}), ctx2) is None
    assert evaluate(clean_definition({"conditions": [{"kind": "no_contact_before", "s": 10}]}), ctx2) == 10.0
    # séquence : l'instant est celui de la dernière condition satisfaite
    combo = clean_definition({"conditions": [{"kind": "players_in_zone", "zone": SQUARE, "min_players": 1}, {"kind": "utility_in_zone", "zone": SQUARE, "types": ["smoke"]}]})
    assert evaluate(combo, ctx2) == 10.0


def test_tactics_api_and_detection(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    teams = {t["name"]: t["id"] for t in c.get("/api/teams").json()}
    assert c.get("/api/tactics/categories").json()[0]["key"] == "mid_round"
    # une tactique « T dans une zone immense » : vraie dès la première trame de chaque round avec positions
    huge = [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]]
    r = c.post("/api/tactics", json={"name": "Partout", "map": "de_nuke", "side": "T", "category": "map_control", "tags": ["test"],
                                     "definition": {"conditions": [{"kind": "players_in_zone", "zone": huge, "min_players": 1}]}})
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    assert r.json()["category_label"] == "Contrôle de carte" and r.json()["tags"] == ["test"]
    assert c.post("/api/tactics", json={"name": "x", "map": "de_nuke", "side": "T", "definition": {"conditions": []}}).status_code == 400
    assert c.post("/api/tactics", json={"name": "x", "map": "de_nuke", "side": "X", "definition": {"conditions": [{"kind": "contact_before"}]}}).status_code == 400
    lst = c.get("/api/tactics?map=de_nuke&side=T").json()
    assert [t["id"] for t in lst] == [tid]
    # la fixture n'a des trames que pour quelques rounds : on prend l'équipe qui a des rounds T observables
    team = next(tid for tid in teams.values() if c.get(f"/api/playbook/{tid}?map=de_nuke&side=T").json()["total"] > 0)
    teams["FaZe"] = team
    pb = c.get(f"/api/playbook/{team}?map=de_nuke&side=T").json()
    assert pb["total"] > 0 and pb["buckets"][0] == "1:55-1:30"
    cats = {cat["key"]: cat for cat in pb["categories"]}
    assert "map_control" in cats and cats["map_control"]["tactics"][0]["name"] == "Partout"
    used = cats["map_control"]["tactics"][0]["used"]
    assert used >= 1 and all(any(s["tactic"] == tid for s in ro["sequence"]) for ro in pb["rounds"] if ro["round_id"] in cats["map_control"]["tactics"][0]["rounds"])
    assert any(t["builtin"] for cat in pb["categories"] for t in cat["tactics"])  # classes automatiques
    assert set(pb["tempo"]) == {"rounds", "buckets", "never", "total"} and set(pb["sites"]) == {"rounds", "A", "B", "none"}
    # fin des defaults et prise du site recopiées du playbook automatique
    assert all({"default_kind", "engage_s", "engage_site"} <= set(ro) for ro in pb["rounds"])
    auto_default = [ro for ro in pb["rounds"] if any(s["tactic"] == "auto:default" for s in ro["sequence"])]
    assert all(ro["default_kind"] in DEFAULT_KINDS for ro in auto_default)
    assert all(s["at_s"] == 0.0 for ro in auto_default for s in ro["sequence"] if s["tactic"] == "auto:default")
    # modification, puis suppression : la détection suit (cache invalidé par la date de modification)
    assert c.patch(f"/api/tactics/{tid}", json={"name": "Partout v2", "category": "rush"}).json()["name"] == "Partout v2"
    pb2 = c.get(f"/api/playbook/{teams['FaZe']}?map=de_nuke&side=T").json()
    assert any(t["name"] == "Partout v2" for cat in pb2["categories"] for t in cat["tactics"])
    assert c.delete(f"/api/tactics/{tid}").json()["ok"] and c.get(f"/api/tactics/{tid}").status_code == 404
    pb3 = c.get(f"/api/playbook/{teams['FaZe']}?map=de_nuke&side=T").json()
    assert not any(t["id"] == tid for cat in pb3["categories"] for t in cat["tactics"])
    assert c.get(f"/api/playbook/{teams['FaZe']}?map=de_dust2&side=T").status_code == 200
    assert c.get(f"/api/playbook/{teams['FaZe']}?map=nope&side=T").status_code == 400
