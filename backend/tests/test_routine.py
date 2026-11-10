# backend/tests/test_routine.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_routine_endpoint(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    match = c.get("/api/matches").json()[0]["id"]
    st = c.get(f"/api/scouting/story?match={match}&steamid=0").status_code
    assert st == 404
    from sqlalchemy import select

    from app.storage.models import MatchPlayer
    with c.app.state.session_factory() as db:
        sid = db.scalar(select(MatchPlayer.steamid).where(MatchPlayer.match_id == match))
    for side in ("CT", "T"):
        r = c.get(f"/api/scouting/routine?match={match}&steamid={sid}&side={side}&armed=false").json()
        assert r["side"] == side and r["rounds"] >= 0
        assert [t["clock"] for t in r["times"]] == ["1:45", "1:35", "1:15", "0:55"]
        for t in r["times"]:
            for p in t["places"]:
                assert p["count"]["n"] == t["alive"] and p["count"]["k"] <= t["alive"]
        for nd in r["nades"]:
            assert nd["count"]["k"] <= r["rounds"] and nd["clock"]
        if r["rounds"]:
            assert r["buys"] and r["buys"][0]["count"]["n"] == r["rounds"]
    armed = c.get(f"/api/scouting/routine?match={match}&steamid={sid}&side=CT").json()
    allr = c.get(f"/api/scouting/routine?match={match}&steamid={sid}&side=CT&armed=false").json()
    assert armed["rounds"] <= allr["rounds"]
    assert c.get(f"/api/scouting/routine?match={match}&steamid={sid}&scope=map").status_code == 200


def test_main_weapon_and_kit():
    import numpy as np

    from app.parsing.model import FLAG_ALIVE
    from app.stats.routine import _kit
    from app.stats.story import _main_weapon
    from app.storage.frames_codec import FrameFields

    weapons = ["", "Knife", "Glock-18", "AK-47", "Smoke Grenade"]
    held = [1, 2, 3, 3, 3, 4, 3, 2]  # l'AK gardée du round précédent est l'arme la plus tenue
    ff = FrameFields(ticks=np.arange(8) * 64, players=["a"], weapons=weapons,
                     fields={"weapon": np.array(held).reshape(8, 1), "flags": np.full((8, 1), FLAG_ALIVE)})
    assert _main_weapon(ff, 0, 0, 7 * 64) == "AK-47"
    ff.fields["weapon"] = np.array([1, 2, 2, 4, 1, 2, 2, 1]).reshape(8, 1)
    assert _main_weapon(ff, 0, 0, 7 * 64) == "Glock-18"  # pas d'arme principale : le pistolet
    # rien acheté sauf des grenades : l'arme gardée apparaît quand même
    assert _kit(["Smoke Grenade", "Flashbang", "Flashbang"], "AK-47") == ["AK-47", "Smoke", "Flash"]
    assert _kit(["M4A1-S", "Kevlar & Helmet"], None) == ["M4A1-S", "Kevlar + casque"]


def test_routine_unused_grenades(client):
    """« Smoke 9/10 · non lancée 4/9 » : chaque ligne de grenade achetée compte les rounds où elle est restée en poche."""
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    match = c.get("/api/matches").json()[0]["id"]
    from app.stats.routine import player_routine

    def rnd(n, items, unused):
        return {"number": n, "side": "T", "buy": "full", "won": True, "path": [],
                "steps": [{"kind": "buy", "t": 0, "items": items, "weapon": "AK-47", "unused": unused}]}

    story = {"name": "x", "rounds": [rnd(2, ["Smoke Grenade", "Flashbang", "Kevlar Vest"], ["Smoke Grenade"]),
                                     rnd(3, ["Smoke Grenade", "Flashbang"], []), rnd(4, ["Smoke Grenade"], ["Smoke Grenade"])]}
    with c.app.state.session_factory() as db:
        out = player_routine(db, {}, "1", match, "T", story_of=lambda mid: story)
    rows = {b["buy"]: b for b in out["buys"]}
    assert (rows["Smoke"]["unused"]["k"], rows["Smoke"]["unused"]["n"]) == (2, 3)
    assert (rows["Flash"]["unused"]["k"], rows["Flash"]["unused"]["n"]) == (0, 2)
    assert "unused" not in rows["AK-47"] and "unused" not in rows["Kevlar"]


def test_story_buy_step_lists_leftover_grenades(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    match = c.get("/api/matches").json()[0]["id"]
    from sqlalchemy import select

    from app.storage.models import MatchPlayer
    with c.app.state.session_factory() as db:
        sids = list(db.scalars(select(MatchPlayer.steamid).where(MatchPlayer.match_id == match)))
    maps = c.app.state.maps
    from app.stats.story import player_story
    with c.app.state.session_factory() as db:
        steps = [s for sid in sids for r in (player_story(db, maps, match, sid) or {"rounds": []})["rounds"]
                 for s in r["steps"] if s["kind"] == "buy"]
    assert steps and all(isinstance(s["unused"], list) and all(isinstance(x, str) for x in s["unused"]) for s in steps)
    assert any(s["unused"] for s in steps)
