# backend/tests/test_duels.py
"""Duels à sec / pris de côté : début du duel (t0), écart de visée de la victime, aide de chaque camp."""
import io
from types import SimpleNamespace as NS

import numpy as np

from app.stats.analysis import _aim_zone, _duel_aim, _duel_start, _helps, match_analysis
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

TR = 64


def _kill(tick=1000, flash_assist=False):
    return NS(tick=tick, attacker="K", victim="V", attacker_x=1000.0, attacker_y=0.0, victim_x=0.0, victim_y=0.0,
              flash_assist=flash_assist)


def test_zone_boundaries():
    assert [_aim_zone(a) for a in (0, 10, 10.1, 45, 45.1, 110, 110.1, 180)] == [
        "viseur", "viseur", "champ", "champ", "cote", "cote", "dos", "dos"]


def test_duel_start_picks_damage_tick():
    k = _kill()
    dmg = [NS(tick=900, attacker="K", victim="V"), NS(tick=980, attacker="K", victim="V"),
           NS(tick=100, attacker="K", victim="V"),  # hors des 3 s avant le kill
           NS(tick=850, attacker="X", victim="V")]  # un autre joueur
    shots = [NS(tick=950, shooter="K", x=1000.0, y=0.0, yaw=180.0)]  # vise la victime, mais après le dégât
    assert _duel_start(k, dmg, shots, TR) == 900


def test_duel_start_uses_earlier_aimed_shot_and_ignores_wild_shots():
    k = _kill()
    dmg = [NS(tick=900, attacker="K", victim="V")]
    shots = [NS(tick=820, shooter="K", x=1000.0, y=0.0, yaw=175.0),   # à 5° de la victime
             NS(tick=810, shooter="K", x=1000.0, y=0.0, yaw=90.0),    # tir ailleurs
             NS(tick=700, shooter="K", x=1000.0, y=0.0, yaw=180.0)]   # trop tôt (plus de 3 s)
    assert _duel_start(k, dmg, shots, TR) == 820
    assert _duel_start(k, [], [], TR) is None
    # le tir de la victime vers le tueur compte aussi
    assert _duel_start(k, [], [NS(tick=900, shooter="V", x=0.0, y=0.0, yaw=3.0)], TR) == 900


def _ff(victim_yaw, n=800, killer_yaw=180.0):
    """Victime en (0,0), tueur en (1000,0) ; `victim_yaw` : yaw par image (ou valeur fixe)."""
    ticks = np.arange(0, n * 4, 4)
    yv = np.full(n, victim_yaw, dtype=float) if np.isscalar(victim_yaw) else np.asarray(victim_yaw, dtype=float)
    f = {"x": np.tile([0.0, 1000.0], (n, 1)), "y": np.zeros((n, 2)), "yaw": np.stack([yv, np.full(n, killer_yaw)], 1),
         "flags": np.ones((n, 2), dtype=int)}
    return NS(ticks=ticks, fields=f)


def test_view_90_degrees_off_is_side():
    off, koff, checked = _duel_aim(_ff(90.0), 0, 1, 2000, TR)
    assert round(off) == 90 and _aim_zone(off) == "cote" and koff < 1 and checked is False


def test_view_never_toward_killer_is_unchecked_and_looking_once_is_checked():
    assert _duel_aim(_ff(90.0), 0, 1, 2000, TR)[2] is False
    yaw = np.full(800, 90.0)
    yaw[400:410] = 5.0  # regarde le tueur (à 5°) vers t0 - 1,5 s
    off, _, checked = _duel_aim(_ff(yaw), 0, 1, 2000, TR)
    assert checked is True and round(off) == 90
    yaw[400:410] = 40.0  # 40° : hors des 15°
    assert _duel_aim(_ff(yaw), 0, 1, 2000, TR)[2] is False


def test_aim_is_measured_before_t0():
    yaw = np.full(800, 90.0)
    yaw[500:] = 0.0  # la victime se tourne vers le tueur à l'image 500 (tick 2000), donc après t0 - 0,25 s
    off, _, _ = _duel_aim(_ff(yaw), 0, 1, 2000, TR)
    assert round(off) == 90


def _ctx(blinds=(), grenades=()):
    side = {"K": "T", "K2": "T", "V": "CT"}
    pos = {"K": (1000.0, 0.0), "V": (0.0, 0.0), "K2": (1100.0, 0.0)}
    return dict(blinds=list(blinds), grenades=list(grenades), side_of=side, pos=pos)


def test_blind_from_killer_side_is_flash_help():
    k = _kill()
    h = _helps(k, 900, TR, **_ctx(blinds=[NS(tick=850, attacker="K2", victim="V", duration=1.5)]))
    assert "flash" in h["killer"] and "flash" not in h["victim"]
    # trop court, trop tôt, ou aveuglement d'un coéquipier de la victime : pas d'aide
    for b in (NS(tick=850, attacker="K2", victim="V", duration=0.3), NS(tick=500, attacker="K2", victim="V", duration=1.5),
              NS(tick=850, attacker="V", victim="V", duration=1.5)):
        assert "flash" not in _helps(k, 900, TR, **_ctx(blinds=[b]))["killer"]
    assert "flash" in _helps(_kill(flash_assist=True), 900, TR, **_ctx())["killer"]


def test_smoke_and_molotov_help_need_activity_and_distance():
    k = _kill()
    fire = NS(type="molotov", thrower="K2", detonate_tick=800, end_tick=1300, detonate_x=100.0, detonate_y=0.0)
    smoke = NS(type="smoke", thrower="K2", detonate_tick=800, end_tick=1600, detonate_x=300.0, detonate_y=0.0)
    h = _helps(k, 900, TR, **_ctx(grenades=[fire, smoke]))
    assert h["killer"] == ["molotov", "smoke", "numbers"] and h["victim"] == []
    far = NS(type="smoke", thrower="K2", detonate_tick=800, end_tick=1600, detonate_x=-900.0, detonate_y=0.0)
    over = NS(type="molotov", thrower="K2", detonate_tick=100, end_tick=500, detonate_x=100.0, detonate_y=0.0)
    assert _helps(k, 900, TR, **_ctx(grenades=[far, over]))["killer"] == ["numbers"]


def test_numbers_help():
    h = _helps(_kill(), 900, TR, **_ctx())
    assert h["killer"] == ["numbers"] and h["victim"] == []  # K et K2 contre V autour du milieu


def test_duels_on_fixture(client):  # noqa: F811
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    mid = wait_ready(c)[0]["match_id"]
    with c.app.state.session_factory() as db:
        a = match_analysis(db, mid)
    assert {"side", "unchecked", "dry", "behind"} <= set(a["reasons"])
    early = [d for d in a["deaths"] if d["round"] <= 3 and d["attacker"] and d["attacker"] != d["victim"]]
    assert early
    assert all(d["aim_zone"] in ("viseur", "champ", "cote", "dos") for d in early)
    assert all({"t0", "aim_offset", "killer_aim_offset", "checked", "help"} <= set(d) and set(d["help"]) == {"killer", "victim"}
               for d in early)
    assert sum(d["aim_zone"] == "dos" for d in early) < 0.15 * len(early)
    assert all(("dry" in d["reasons"]) == (not d["help"]["victim"]) for d in early)
    assert all(("side" in d["reasons"]) == (d["aim_zone"] == "cote") for d in early)
    assert all(("behind" in d["reasons"]) == (d["aim_zone"] == "dos") for d in early)
    for p in a["players"]:
        assert set(p["duels"]) <= {"viseur", "champ", "cote", "dos"} and len(p["dry"]) == 2
        assert sum(v[1] for v in p["duels"].values()) <= p["deaths"]


def test_duel_metrics(client):  # noqa: F811
    from app.stats.debrief import ISSUE_KEYS, METRICS, team_match_metrics
    for key, ref in (("dry", 0.55), ("off_aim", 0.18)):
        assert METRICS[key]["better"] == "down" and METRICS[key]["ref"] == ref and key in ISSUE_KEYS
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    mid = wait_ready(c)[0]["match_id"]
    with c.app.state.session_factory() as db:
        a = match_analysis(db, mid)
        team = a["players"][0]["team_id"]
        m = team_match_metrics(db, mid, team, a)
    mine = [d for d in a["deaths"] if d["team_id"] == team and d["aim_zone"]]
    assert m["dry"]["n"] == len(mine) > 0 and m["dry"]["k"] == sum("dry" in d["reasons"] for d in mine)
    assert m["off_aim"]["k"] == sum(d["aim_zone"] in ("cote", "dos") for d in mine)


def test_career_extras_duels(client):  # noqa: F811
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    ex = c.get("/api/players/extras").json()
    assert all(set(v["duels"]) <= {"viseur", "champ", "cote", "dos"} and len(v["dry"]) == 2 for v in ex.values())
    assert sum(w + l for v in ex.values() for w, l in v["duels"].values()) > 0


def test_duel_start_ignores_the_killing_blow_itself():
    k = _kill()
    assert _duel_start(k, [NS(tick=1000, attacker="K", victim="V")], [], TR) is None
