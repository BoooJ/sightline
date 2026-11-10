# backend/tests/test_repository.py
from app.storage.models import Demo, Kill, Round
from app.storage.repository import get_match_detail, get_round_replay, list_matches, save_parsed_demo


def _demo(db):
    d = Demo(path="/x/nuke.dem", file_name="nuke.dem", size=1, sha256="a" * 64, status="parsing")
    db.add(d)
    db.flush()
    return d


def test_save_and_list(db, nuke_parsed, maps):
    d = _demo(db)
    mid = save_parsed_demo(db, d.id, nuke_parsed, maps)
    db.commit()
    rows = list_matches(db)
    assert len(rows) == 1 and rows[0]["id"] == mid
    r = rows[0]
    assert {r["team_a"]["name"], r["team_b"]["name"]} == {"FaZe", "3DMAX"}
    scores = {r["team_a"]["name"]: r["score_a"], r["team_b"]["name"]: r["score_b"]}
    assert scores == {"3DMAX": 13, "FaZe": 10}
    assert r["rounds_count"] == 23 and r["map_display_name"] == "Nuke"
    assert list_matches(db, map_name="de_dust2") == []
    assert len(list_matches(db, q="faze")) == 1
    assert db.query(Kill).count() == 151


def test_save_twice_replaces(db, nuke_parsed, maps):
    d = _demo(db)
    save_parsed_demo(db, d.id, nuke_parsed, maps)
    save_parsed_demo(db, d.id, nuke_parsed, maps)
    db.commit()
    assert db.query(Round).count() == 23


def test_match_detail(db, nuke_parsed, maps):
    d = _demo(db)
    mid = save_parsed_demo(db, d.id, nuke_parsed, maps)
    db.commit()
    det = get_match_detail(db, mid)
    assert len(det["rounds"]) == 23 and len(det["players"]) == 10
    faze_id = next(t["id"] for t in (det["team_a"], det["team_b"]) if t["name"] == "FaZe")
    first_half = det["halves"][0]
    faze_first = first_half["a"] if det["team_a"]["id"] == faze_id else first_half["b"]
    assert faze_first == 7
    assert sum(p["kills"] for p in det["players"]) <= 151
    assert all(0 <= p["adr"] < 200 for p in det["players"])
    assert det["rounds"][-1]["score_a_after"] + det["rounds"][-1]["score_b_after"] == 23


def test_round_replay(db, nuke_parsed, maps):
    d = _demo(db)
    mid = save_parsed_demo(db, d.id, nuke_parsed, maps)
    db.commit()
    rid = get_match_detail(db, mid)["rounds"][1]["id"]
    rep = get_round_replay(db, rid)
    assert rep["map_name"] == "de_nuke" and rep["frames"]["m"] == 10
    assert rep["kills"] and rep["grenades"] and rep["shots"]
    assert all(len(g["trajectory"]) >= 2 for g in rep["grenades"])
    # dégâts : réels (bornés à la vie, pour l'ADR) et bruts, armure et arme (coup de couteau dans le dos de la vue du joueur)
    dmgs = rep["damages"]
    assert dmgs and all(set(d) == {"tick", "attacker", "victim", "dmg", "raw", "armor", "weapon", "hitgroup"} for d in dmgs)
    assert all(d["raw"] >= d["dmg"] >= 0 and d["armor"] >= 0 and isinstance(d["weapon"], str) for d in dmgs)
    assert any(d["raw"] > d["dmg"] for d in dmgs)  # le coup qui tue dépasse la vie restante
    assert {"ak47", "m4a1"} & {d["weapon"] for d in dmgs}
    plants = [b for b in get_round_replay(db, get_match_detail(db, mid)["rounds"][2]["id"])["bomb"]
              if b["type"] == "plant"]
    assert all(b["site"] in ("A", "B") for b in plants)
    # round sans frames (fixture tronquée) : frames == None
    rid_late = get_match_detail(db, mid)["rounds"][10]["id"]
    assert get_round_replay(db, rid_late)["frames"] is None



def test_match_detail_strip(db, nuke_parsed, maps):
    d = _demo(db)
    mid = save_parsed_demo(db, d.id, nuke_parsed, maps)
    db.commit()
    det = get_match_detail(db, mid)
    for r in det["rounds"]:
        assert 0 <= r["survivors_a"] <= 5 and 0 <= r["survivors_b"] <= 5
        winner_a = r["winner_team_id"] == det["team_a"]["id"]
        if r["end_reason"] in ("ct_killed", "t_killed"):  # victoire par élimination : le perdant n'a plus de survivant
            assert (r["survivors_b"] if winner_a else r["survivors_a"]) == 0
    reasons = {r["end_reason"]: r["bomb"] for r in det["rounds"] if r["end_reason"] in ("bomb_exploded", "bomb_defused")}
    assert reasons.get("bomb_exploded") == "exploded" and reasons.get("bomb_defused") == "defused"
    assert sum(r["bomb"] is not None for r in det["rounds"]) == 10
