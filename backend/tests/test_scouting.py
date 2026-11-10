# backend/tests/test_scouting.py
import io

import pytest
from fastapi import HTTPException

from app.api.scouting import tactic_round_ids
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_tactic_round_ids_default_kind():
    """Filtre de rounds : « t:<cat> », « t:<cat>:<site> » et le sous-type du default « t:default::<kind> »."""
    pb = {"t": {"list": [{"round_id": 1, "category": "default", "site": "A", "default_kind": "take"},
                         {"round_id": 2, "category": "default", "site": None, "default_kind": "duels"},
                         {"round_id": 3, "category": "rush", "site": "B", "default_kind": None}]}, "ct": {"list": []}}
    assert tactic_round_ids(pb, "t:default") == ({1, 2}, "T")
    assert tactic_round_ids(pb, "t:default:A")[0] == {1}
    assert tactic_round_ids(pb, "t:default:none")[0] == {2}
    assert tactic_round_ids(pb, "t:default::duels")[0] == {2}
    assert tactic_round_ids(pb, "t:default:*:take")[0] == {1}
    assert tactic_round_ids(pb, "t:rush:B")[0] == {3}
    with pytest.raises(HTTPException) as e:
        tactic_round_ids(pb, "zz")
    assert e.value.status_code == 400


def test_scouting_report(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    teams = c.get("/api/scouting/teams").json()
    assert {t["name"] for t in teams} == {"FaZe", "3DMAX"} and all(t["matches"] == 1 for t in teams)
    faze = next(t for t in teams if t["name"] == "FaZe")
    assert faze["wins"] == 0
    r = c.get(f"/api/scouting/teams/{faze['id']}").json()
    assert r["matches"] == 1 and r["recent"][0]["result"] == "L" and r["recent"][0]["opponent"] == "3DMAX"
    nuke = r["maps"][0]
    assert nuke["map"] == "de_nuke" and nuke["played"] == 1 and nuke["rounds_won"] == 10 and nuke["rounds_lost"] == 13
    assert nuke["ct"]["rounds"] + nuke["t"]["rounds"] == 23
    assert nuke["ct"]["won"] + nuke["t"]["won"] == 10
    s = nuke["sites"]["total"]
    assert s["rounds"] == nuke["t"]["rounds"] and s["A"] + s["B"] + s["none"] == s["rounds"]
    assert len(r["players"]) == 5 and r["players"][0]["rating"] >= r["players"][-1]["rating"]
    util = c.get(f"/api/scouting/teams/{faze['id']}/utility?map=de_nuke").json()
    assert set(util) == {"T", "CT"} and all(lu["count"] >= 1 for lu in util["T"] + util["CT"])
    assert c.get("/api/scouting/teams/999").status_code == 404


def test_playbook(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    teams = {t["name"]: t["id"] for t in c.get("/api/scouting/teams").json()}
    for name, tid in teams.items():
        pb = c.get(f"/api/scouting/teams/{tid}/playbook?map=de_nuke").json()
        t, ct = pb["t"], pb["ct"]
        assert sum(x["n"] for x in t["categories"]) == t["rounds"] == len(t["list"])
        assert all(x["category"] in ("rush", "execute", "split", "fake", "default", "eco") for x in t["list"])
        assert all(sum(r["counts"].values()) <= 5 for r in ct["list"])
        assert sum(s["n"] for s in ct["setups"]) == ct["rounds"]
        assert all(len(x["rounds"]) == x["n"] for x in t["categories"])
        for d in ct["sites"].values():
            assert d["held"] + d["plants"] <= d["attacked"] and d["retakes_won"] <= d["plants"]
        assert sum(d["attacked"] for d in ct["sites"].values()) <= ct["rounds"]


def test_veto_data(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    teams = {t["name"]: t["id"] for t in c.get("/api/scouting/teams").json()}
    v = c.get(f"/api/scouting/veto?team_a={teams['3DMAX']}&team_b={teams['FaZe']}&maps=de_nuke,de_mirage").json()
    nuke = next(m for m in v["maps"] if m["map"] == "de_nuke")
    mirage = next(m for m in v["maps"] if m["map"] == "de_mirage")
    assert nuke["a"]["won"] == 1 and nuke["b"]["won"] == 0 and nuke["p_a"] > 0.5
    assert mirage["p_a"] == 0.5 and mirage["a"]["played"] == 0
    assert v["head_to_head"][0]["score"] == [13, 10]
    assert c.get("/api/scouting/veto?team_a=1&team_b=999").status_code == 404


def test_learn_poste(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    d = c.get("/api/scouting/learn?map=de_nuke&side=CT").json()
    assert d["postes"] and d["entries"] == []
    top = d["postes"][0]
    assert top["rounds"] >= 2 and 0 <= top["win_pct"] <= 100 and top["players"]
    # tous les postes réunis = un joueur CT vivant par poste et par round, au plus 5 par round
    assert sum(p["rounds"] for p in d["postes"]) <= 5 * 23
    e = c.get(f"/api/scouting/learn?map=de_nuke&side=CT&place={top['place']}").json()["entries"]
    assert len(e) == top["rounds"]
    x = e[0]
    assert x["path"] and x["start_tick"] <= x["end_tick"] and x["kills"] >= 0
    assert all(g["type"] for g in x["grenades"]) and (x["death"] is None or x["death"]["time_s"] >= 0)
    assert x["buy"] in ("pistol", "eco", "semi", "force", "full") and x["rate"] > 0 and x["round_end_s"] > 0
    assert all(k["tick"] > 0 for k in x["kills_detail"]) and len(x["kills_detail"]) == x["kills"]
    assert sum(top["by_player"].values()) == top["rounds"]
    assert c.get("/api/scouting/learn?map=de_nuke&side=X").status_code == 400


def test_role_profiles(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    for side, roles in (("T", {"entry", "second", "lurker", "support", "awper"}), ("CT", {"anchor_a", "anchor_b", "info", "rotator", "support", "awper"})):
        d = c.get(f"/api/scouting/roles?map=de_nuke&side={side}").json()
        assert set(d["roles"]) == roles and len(d["players"]) == 10
        for p in d["players"]:
            assert abs(sum(p["scores"].values()) - 1) < 0.01 and p["primary"] in roles and p["rounds"] > 0
            assert 0 <= p["kpis"]["survival"] <= 1 and len(p["round_list"]) <= p["rounds"]
        assert sum(b["players"] for b in d["benchmarks"].values()) == 10
        assert any(p["round_list"] for p in d["players"])  # rounds rejouables (avec positions) proposés à l'étude
    assert c.get("/api/scouting/roles?map=de_nuke&side=X").status_code == 400


def test_player_story(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    m = c.get("/api/matches").json()[0]
    players = c.get(f"/api/matches/{m['id']}").json()["players"]
    d = c.get(f"/api/scouting/story?match={m['id']}&steamid={players[0]['steamid']}").json()
    assert d["name"] == players[0]["name"] and d["team"] and d["opponent"] and d["rate"] > 0
    assert len(d["rounds"]) >= 3  # rounds avec positions (la démo de test n'en garde que quelques-uns)
    kinds = set()
    for r in d["rounds"]:
        assert r["side"] in ("CT", "T") and r["path"] and r["start_tick"] <= r["end_tick"]
        st = r["steps"]
        assert st[0]["kind"] == "buy" and st[-1]["kind"] == "end"
        assert [s["tick"] for s in st] == sorted(s["tick"] for s in st)
        assert sum(s["kind"] == "kill" for s in st) == r["kills"] and sum(s["kind"] == "death" for s in st) == int(r["died"])
        assert sum(s["kind"] == "place" and s["first"] for s in st) <= 1
        kinds |= {s["kind"] for s in st}
        assert all(len(s["mates"]) <= 4 and all(m["name"] != d["name"] for m in s["mates"]) for s in st)
        assert st[0]["mates"] and st[0]["enemies"], "au début du round, tout le monde est en vie"
        assert all(len(s["enemies"]) <= 5 for s in st)
        assert all(u["type"] and len(u["trajectory"]) >= 2 for s in st for u in s["enemy_utility"])
        assert r["plant_t"] is None or r["plant_t"] >= 0
        for s in st:
            if s["kind"] == "nade":
                assert s["trajectory"] and len(s["trajectory"][0]) == 3 and s["target"]
                assert s["setpos"] is None or s["setpos"].startswith("setpos ")
    assert {"buy", "place", "nade", "kill", "death", "end"} <= kinds
    assert sum(len(r["steps"]) for r in d["rounds"]) < 23 * 20  # une histoire courte, pas un journal de bord
    assert c.get(f"/api/scouting/story?match={m['id']}&steamid=123").status_code == 404
    assert c.get("/api/scouting/story?match=999&steamid=1").status_code == 404
