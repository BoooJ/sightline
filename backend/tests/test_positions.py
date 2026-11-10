# backend/tests/test_positions.py
"""Rôles EDGE (Lurk / Demi-lurk / Pack / T polyvalent ; Ancre / Rotation / CT polyvalent) et postes de carte."""
import io

from app.stats.positions import EDGE_ROLE_LABELS, EDGE_ROLES_CT, EDGE_ROLES_T, MIN_ROUNDS, _agg_ct, _agg_t, player_positions
from app.storage.models import Demo
from app.storage.repository import save_parsed_demo
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_aggregation_rules():
    assert _agg_t([("Ramp", 100.0)] * (MIN_ROUNDS - 1))["role"] is None  # trop peu de rounds
    pack = _agg_t([("Ramp", 300.0)] * 5 + [("Lobby", 2000.0)] * 3)
    assert pack["role"] == "pack" and pack["poste"] == "Ramp" and pack["rounds"] == 8
    lurk = _agg_t([("Outside", 1800.0)] * 6 + [("Ramp", 200.0)] * 2)
    assert lurk["role"] == "lurk" and lurk["poste"] == "Outside"
    half = _agg_t([("A", 200.0), ("B", 900.0), ("C", 2000.0)] * 3)
    assert half["role"] == "half_lurk" and half["poste"] is None  # aucun lieu ≥ 35 %
    allround = _agg_t([("A", 200.0)] * 5 + [("B", 700.0)] * 3 + [("C", None)] * 2)
    assert allround["role"] == "t_allround"
    anchor = _agg_ct([("Ramp", "B", "Ramp")] * 6 + [("Heaven", "A", "Heaven")] * 2)
    assert anchor["role"] == "anchor" and anchor["poste"] == "Ramp"
    rot = _agg_ct([("Outside", None, None), ("Heaven", None, None), ("Ramp", None, None)] * 3)
    assert rot["role"] == "rotation" and rot["poste"] is None
    mid = _agg_ct([("Outside", None, None)] * 4 + [("Heaven", None, None)] * 3 + [("Ramp", None, None)] * 2)
    assert mid["role"] == "ct_allround" and mid["poste"] == "Outside"
    assert set(EDGE_ROLES_T) | set(EDGE_ROLES_CT) == set(EDGE_ROLE_LABELS)


def test_positions_on_fixture(db, nuke_parsed, maps):
    d = Demo(path="/x/nuke.dem", file_name="nuke.dem", size=1, sha256="a" * 64, status="parsing")
    db.add(d)
    db.flush()
    mid = save_parsed_demo(db, d.id, nuke_parsed, maps)
    db.commit()
    out = player_positions(db, maps)
    assert len(out) == 10
    for o in out.values():
        assert set(o) >= {"T", "CT", "maps", "matches"} and set(o["maps"]) == {"de_nuke"} and set(o["matches"]) == {mid}
        for side in ("T", "CT"):
            a = o[side]
            assert a["rounds"] >= 0 and (a["role"] is None) == (a["rounds"] < MIN_ROUNDS)
            if a["role"]:
                assert a["role"] in (EDGE_ROLES_T if side == "T" else EDGE_ROLES_CT) and a["map"] == "de_nuke"
    # la fixture n'a des positions que pour quelques rounds : la règle des 6 rounds laisse les rôles vides
    assert player_positions(db, maps, match_ids=set()) == {}
    assert player_positions(db, maps, map_name="de_dust2") == {}


def test_positions_api(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    rows = c.get("/api/players").json()
    assert all("edge_roles" in p and set(p["edge_roles"]) == {"t", "ct"} for p in rows)
    labels = c.get("/api/players/roles").json()
    assert "anchor" in labels and "awper" in labels
    with_role = [p for p in rows if p["edge_roles"]["ct"]["role"]]
    if with_role:
        role = with_role[0]["edge_roles"]["ct"]["role"]
        sub = c.get(f"/api/players?role={role}").json()
        assert sub and all(p["edge_roles"]["ct"]["role"] == role or p["edge_roles"]["t"]["role"] == role for p in sub)
    sid = rows[0]["steamid"]
    p = c.get(f"/api/players/{sid}").json()
    assert "positions" in p and "de_nuke" in p["positions"] and "edge_roles" in p
    bm = c.get(f"/api/players/{sid}/roles-by-match").json()
    assert set(bm) == {str(p["history"][0]["match"]["id"])} and set(bm[next(iter(bm))]) == {"t", "ct"}


def test_positions_read_at_most_16_frames_per_second(db, nuke_parsed, nuke_parsed_32, maps, monkeypatch):
    """La boucle par image (lieu, distance au coéquipier) lit au plus 16 images par seconde : une démo à 32 i/s ne coûte
    pas le double, et donne les mêmes postes, rôles et distances que la même démo à 16 i/s."""
    from app.stats import positions

    calls = []
    real = positions.place_of
    monkeypatch.setattr(positions, "place_of", lambda *a: calls.append(1) or real(*a))
    out, cost = [], []
    for i, parsed in enumerate((nuke_parsed, nuke_parsed_32)):
        d = Demo(path=f"/x/{i}.dem", file_name=f"{i}.dem", size=1, sha256=str(i) * 64, status="parsing")
        db.add(d)
        db.flush()
        mid = save_parsed_demo(db, d.id, parsed, maps)
        db.commit()
        calls.clear()
        res = player_positions(db, maps, match_ids={mid})
        cost.append(len(calls))
        out.append({sid: {k: v for k, v in o.items() if k not in ("matches", "round_place")} for sid, o in res.items()})
    assert cost[0] > 100 and cost[1] == cost[0]
    assert out[1] == out[0]
