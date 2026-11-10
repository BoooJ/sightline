# backend/tests/test_stats.py
from app.stats.compute import match_stats
from app.storage.models import Demo
from app.storage.repository import get_match_detail, save_parsed_demo


def _match(db, nuke_parsed, maps):
    d = Demo(path="/x/nuke.dem", file_name="nuke.dem", size=1, sha256="a" * 64, status="parsing")
    db.add(d)
    db.flush()
    mid = save_parsed_demo(db, d.id, nuke_parsed, maps)
    db.commit()
    return mid


def test_matches_scoreboard(db, nuke_parsed, maps):
    mid = _match(db, nuke_parsed, maps)
    s, ref = match_stats(db, mid), {p["steamid"]: p for p in get_match_detail(db, mid)["players"]}
    assert len(s["players"]) == 10
    for p in s["players"]:
        r = ref[p["steamid"]]
        assert (p["kills"], p["deaths"], p["assists"], p["adr"]) == (r["kills"], r["deaths"], r["assists"], r["adr"])
        assert p["rounds"] == 23 and 0 <= p["kast"] <= 100 and 0 < p["rating"] < 3
        assert p["clutches_won"] <= p["clutches_played"]
    # une seule ouverture par round
    assert sum(p["opening_kills"] for p in s["players"]) == 23 == sum(p["opening_deaths"] for p in s["players"])
    teams = {t["name"]: t for t in s["teams"]}
    assert teams["3DMAX"]["rounds_won"] == 13 and teams["FaZe"]["rounds_won"] == 10
    assert teams["FaZe"]["opening_won"] + teams["3DMAX"]["opening_won"] == 23
    assert sum(v["played"] for v in teams["FaZe"]["buy"].values()) == 23


def test_side_split_adds_up(db, nuke_parsed, maps):
    mid = _match(db, nuke_parsed, maps)
    full, ct, t = match_stats(db, mid), match_stats(db, mid, "CT"), match_stats(db, mid, "T")
    by = lambda st: {p["steamid"]: p for p in st["players"]}
    fb, cb, tb = by(full), by(ct), by(t)
    for sid, p in fb.items():
        for k in ("kills", "deaths", "assists", "rounds", "opening_kills", "trade_kills", "utility_dmg", "clutches_played"):
            assert cb[sid][k] + tb[sid][k] == p[k], (sid, k)
    for tf, tc, tt in zip(full["teams"], ct["teams"], t["teams"]):
        assert tc["rounds_won"] + tt["rounds_won"] == tf["rounds_won"]


def test_duels_match_kills(db, nuke_parsed, maps):
    mid = _match(db, nuke_parsed, maps)
    s = match_stats(db, mid)
    for p in s["players"]:
        assert sum(s["duels"].get(p["steamid"], {}).values()) == p["kills"]
    assert match_stats(db, 999) is None


def test_economy_split(db, nuke_parsed, maps):
    mid = _match(db, nuke_parsed, maps)
    full = {p["steamid"]: p for p in match_stats(db, mid)["players"]}
    parts = {e: {p["steamid"]: p for p in match_stats(db, mid, econ=e)["players"]} for e in ("buy", "eco", "pistol")}
    for sid, p in full.items():
        # pistol + achat + eco couvrent tous les rounds (pistol, eco, semi, force, full)
        assert sum(parts[e][sid]["rounds"] for e in parts) == p["rounds"]
        assert sum(parts[e][sid]["kills"] for e in parts) == p["kills"]
    vs = {p["steamid"]: p for p in match_stats(db, mid, econ="vs_eco")["players"]}
    assert all(vs[sid]["rounds"] <= parts["buy"][sid]["rounds"] for sid in vs)
    assert all(p["rounds"] == 2 for p in parts["pistol"].values())
