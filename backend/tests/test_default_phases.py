# backend/tests/test_default_phases.py
"""Playbook T « Default en phases » : prise du site, sous-types du default, pression et rotation CT."""
import io

import numpy as np
import pytest
from sqlalchemy import select

from app.stats.playbook import (
    DEFAULT_KIND_LABELS,
    DEFAULT_KINDS,
    SitePlaces,
    TDeath,
    TNade,
    TRoundCtx,
    _first_run,
    _site_places_from,
    classify_t_round,
    ct_rotation,
    engagement,
    match_t_rounds,
    pressure,
    rotation_measurable,
    site_membership,
)
from app.storage.models import Match
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

# valeurs imprimées par le code d'avant « Default en phases » (16/10/2026) : (catégorie, site, contact, pose, utilitaires, près du site)
EXPECTED = {1: ("execute", "B", 26.0, None, 3, 3), 2: ("eco", "A", 11.9, None, 0, 1), 3: ("default", "B", 10.3, 61.7, 4, 0)}
# nouveaux champs sur la même fixture (règles du 16/10/2026) : (prise, site pris, sous-type, pression, site pressé).
# À changer exprès quand la correction des sites de pose sur Nuke arrivera.
NEW = {1: (None, None, None, 32.1, "B"), 2: (None, None, None, None, None), 3: (52.9, "B", "take", 10.3, "A")}


def test_playbook_fixture_characterization(client):
    """Règles d'avant inchangées sur la fixture (3DMAX en T aux rounds 1-3, seuls rounds avec positions)."""
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    dmax = next(t["id"] for t in c.get("/api/scouting/teams").json() if t["name"] == "3DMAX")
    rows = {x["number"]: x for x in c.get(f"/api/scouting/teams/{dmax}/playbook?map=de_nuke").json()["t"]["list"]}
    keys = ("category", "site", "contact_s", "plant_s", "util_before", "near_site")
    assert {n: tuple(rows[n][k] for k in keys) for n in rows} == EXPECTED  # valeurs relevées sur le code actuel


def test_playbook_default_phases_on_fixture(client):
    """Invariants des nouveaux champs sur la fixture, pour les deux équipes (pas de comptes en dur)."""
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    teams = {t["name"]: t["id"] for t in c.get("/api/scouting/teams").json()}
    maps = c.app.state.maps
    new = ("engage_s", "engage_site", "default_kind", "pressure_s", "pressure_site", "ct_rotation_s")
    with c.app.state.session_factory() as db:
        mids = [m.id for m in db.scalars(select(Match))]
        for tid in teams.values():
            t = c.get(f"/api/scouting/teams/{tid}/playbook?map=de_nuke").json()["t"]
            for x in t["list"]:
                assert all(k in x for k in new)
                assert (x["default_kind"] is not None) == (x["category"] == "default")
                assert x["default_kind"] is None or x["default_kind"] in DEFAULT_KINDS
                assert x["late_exec"] == (x["default_kind"] == "exec")
                assert x["engage_site"] in ("A", "B", None) and x["pressure_site"] in ("A", "B", None)
                assert x["engage_s"] is None or x["engage_s"] >= 5 or x["engage_s"] == x["plant_s"]
                if x["plant_s"] is not None:
                    assert x["engage_s"] is not None and x["engage_s"] <= x["plant_s"]
                assert x["pressure_s"] is None or x["plant_s"] is None or x["pressure_s"] <= x["plant_s"]
                if x["ct_rotation_s"] is not None:
                    assert x["pressure_s"] < x["ct_rotation_s"] <= x["pressure_s"] + 15.1
                # Nuke : les centres des sites A et B sont superposés (moins de ROT_FROM_R) → rotation non mesurable
                assert x["rotation_measurable"] is False and x["ct_rotation_s"] is None
            n_default = next((g["n"] for g in t["categories"] if g["key"] == "default"), 0)
            assert sum(k["n"] for k in t["default_kinds"]) == n_default
            assert [k["key"] for k in t["default_kinds"]] == [k for k in DEFAULT_KINDS if k in {g["key"] for g in t["default_kinds"]}]
            assert all(k["label"] == DEFAULT_KIND_LABELS[k["key"]] and len(k["rounds"]) == k["n"] for k in t["default_kinds"])
            e = t["engage_by_site"]
            assert set(e) == {"A", "B", "none"}
            assert e["A"]["n"] + e["B"]["n"] + e["none"] == sum(x["category"] != "eco" for x in t["list"])
            for s in ("A", "B"):
                assert (e[s]["median_s"] is None) == (e[s]["n"] == 0) and len(e[s]["rounds"]) == e[s]["n"]
            for mid in mids:
                assert match_t_rounds(db, maps, mid, tid) == [x for x in t["list"] if x["match_id"] == mid]
        assert match_t_rounds(db, maps, 999, teams["3DMAX"]) == [] and match_t_rounds(db, maps, mids[0], 999) == []
    dmax = {x["number"]: x for x in c.get(f"/api/scouting/teams/{teams['3DMAX']}/playbook?map=de_nuke").json()["t"]["list"]}
    keys = ("engage_s", "engage_site", "default_kind", "pressure_s", "pressure_site")
    assert {n: tuple(x[k] for k in keys) for n, x in dmax.items()} == NEW
    r3 = dmax[3]
    tim = c.get(f"/api/scouting/teams/{teams['3DMAX']}/timings?map=de_nuke&side=T&tactic=t:default::{r3['default_kind']}")
    assert tim.status_code == 200 and [x["round_id"] for x in tim.json()["list"]] == [r3["round_id"]]


def test_rotation_path_on_fixture_with_distant_sites(client, monkeypatch):
    """Fixture Nuke avec le site B éloigné de 3 000 u : la rotation devient mesurable. Les colonnes CT des trames vont
    bien dans ct_x…, et le brief compte les rotations sur les rounds hors eco."""
    import app.stats.playbook as pbm
    real = pbm.site_centers

    def far(session, maps, map_name):
        centers = dict(real(session, maps, map_name))
        x, y, z = centers["B"]
        centers["B"] = (x + 3000.0, y, z)
        return centers
    seen, classify = [], pbm.classify_t_round
    monkeypatch.setattr(pbm, "site_centers", far)
    monkeypatch.setattr(pbm, "classify_t_round", lambda ctx: (seen.append(ctx), classify(ctx))[1])
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    checked = 0
    for tm in c.get("/api/scouting/teams").json():
        t_list = c.get(f"/api/scouting/teams/{tm['id']}/playbook?map=de_nuke").json()["t"]["list"]
        assert all(x["rotation_measurable"] is True for x in t_list)   # (la fixture n'a de trames T que pour 3DMAX)
        for q in ("", "&armed=true"):
            bb = c.get(f"/api/scouting/teams/{tm['id']}/brief?map=de_nuke{q}").json()
            kept = [x for x in t_list if str(x["round_id"]) in bb["round_index"] and x["category"] != "eco"]
            rot = [x["round_id"] for x in kept if x["ct_rotation_s"] is not None]
            if not kept:
                assert bb["ct_rotation"] is None
                continue
            checked += 1
            assert (bb["ct_rotation"]["k"], bb["ct_rotation"]["n"]) == (len(rot), len(kept))
            assert bb["ct_rotation"]["rounds"] == rot
    assert checked and seen
    for ctx in seen:   # au début du round, les CT sont plus près du site A (spawn CT de Nuke) que les T
        a = ctx.sites["A"]
        i = int(np.searchsorted(ctx.ticks, ctx.t0))
        ct_d = float(np.hypot(ctx.ct_x[i] - a[0], ctx.ct_y[i] - a[1]).mean())
        t_d = float(np.hypot(ctx.t_x[i] - a[0], ctx.t_y[i] - a[1]).mean())
        assert ctx.ct_x.shape == ctx.ct_alive.shape and ct_d < t_d


# --- fonctions pures (données synthétiques, jamais la base) ---------------------------------------------------------

FPS = 16
SITES = {"A": (0.0, 0.0, 0.0), "B": (4000.0, 0.0, 0.0)}
PLACES = {"BombsiteA": (0.0, 0.0, 0.0), "BombsiteB": (4000.0, 0.0, 0.0), "Ramp": (1000.0, 0.0, 0.0), "Mid": (2000.0, 0.0, 0.0)}
FAR_T, FAR_CT = (2000.0, 3000.0), (2000.0, -3000.0)   # loin de tout : ni site, ni lieu de site, ni pression
NUKE_PLACES = {"BombsiteA": (607.0, -1046.0, -410.0), "BombsiteB": (657.0, -753.0, -716.0)}
KEYS = {"category", "site", "contact_s", "plant_s", "util_before", "near_site", "late_exec", "engage_s", "engage_site",
        "default_kind", "pressure_s", "pressure_site", "ct_rotation_s", "rotation_measurable"}


def _places(pl=PLACES):   # une carte à un seul niveau
    names = tuple(pl)
    arr = lambda i: np.array([pl[p][i] for p in names], dtype=float)  # noqa: E731
    return SitePlaces(names, arr(0), arr(1), arr(2), np.full(len(names), -np.inf), np.full(len(names), np.inf),
                      {p[-1]: i for i, p in enumerate(names) if p in ("BombsiteA", "BombsiteB")})


def _ctx(seconds=100, kt=5, kct=5, fps=FPS, **kw):
    n = seconds * fps
    ticks = np.arange(n) * (64 // fps)         # 64 ticks/s, une image tous les 64 // fps ticks
    d = dict(rate=64, fps=fps, t0=0, end_tick=int(ticks[-1]), buy="full", end_reason="t_killed", ticks=ticks,
             t_x=np.full((n, kt), FAR_T[0]), t_y=np.full((n, kt), FAR_T[1]), t_z=np.zeros((n, kt)), t_alive=np.ones((n, kt), bool),
             ct_x=np.full((n, kct), FAR_CT[0]), ct_y=np.full((n, kct), FAR_CT[1]), ct_z=np.zeros((n, kct)),
             ct_alive=np.ones((n, kct), bool), contact_tick=None, plant_tick=None, plant_site=None, nades=[], deaths=[],
             sites=dict(SITES), places=_places())
    d.update(kw)
    return TRoundCtx(**d)


def _put(ctx, cols, x, y, from_s, frames=None, z=0.0, side="t"):
    """Place les joueurs `cols` en (x, y, z) pendant `frames` images à partir de from_s (None : jusqu'à la fin)."""
    a = int(from_s * ctx.fps)
    b = len(ctx.ticks) if frames is None else a + frames
    for f, v in (("x", x), ("y", y), ("z", z)):
        getattr(ctx, f"{side}_{f}")[a:b, cols] = v
    return ctx


def _nade(t, x, y, kind="smoke", det=None, z=0.0, det_none=False):
    return TNade(kind, int(t * 64), None if det_none else int((t if det is None else det) * 64), x, y, z)


def test_first_run():
    assert _first_run(np.array([1, 1, 0, 1, 1, 1], bool), 3) == 3
    assert _first_run(np.ones(16, bool), 16) == 0
    assert _first_run(np.ones(15, bool), 16) is None
    assert _first_run(np.zeros(0, bool), 16) is None


def test_site_places_level_bounds(maps):
    pl = _site_places_from(maps["de_nuke"], NUKE_PLACES)
    a, b = pl.site_idx["A"], pl.site_idx["B"]
    assert (pl.zlo[a], pl.zhi[a]) == (-495, 10000) and (pl.zlo[b], pl.zhi[b]) == (-10000, -495)
    assert pl.names == ("BombsiteA", "BombsiteB") and pl.cz[b] == -716.0
    mir = _site_places_from(maps["de_mirage"], PLACES)
    assert np.all(np.isneginf(mir.zlo)) and np.all(np.isposinf(mir.zhi)) and mir.site_idx == {"A": 0, "B": 1}
    assert _site_places_from(maps["de_mirage"], {"Mid": (0.0, 0.0, 0.0)}).site_idx == {}
    assert _site_places_from(maps["de_mirage"], {}) is None


def test_membership_nearest_place_and_floor(maps):
    pl = _places()
    on = site_membership(pl, np.array([600.0, -600.0, -800.0, 4100.0]), np.zeros(4), np.zeros(4))
    assert on["A"].tolist() == [False, True, False, False]    # Ramp plus proche ; sur A ; au-delà de 700 u
    assert on["B"].tolist() == [False, False, False, True]
    on2 = site_membership(pl, np.full((2, 2), -600.0), np.zeros((2, 2)), np.zeros((2, 2)))
    assert on2["A"].shape == (2, 2) and on2["A"].all()
    mask = np.array([[True, False], [False, True]])   # positions à ignorer (T mort, image hors fenêtre…)
    assert site_membership(pl, np.full((2, 2), -600.0), np.zeros((2, 2)), np.zeros((2, 2)), mask)["A"].tolist() == mask.tolist()
    nuke = _site_places_from(maps["de_nuke"], NUKE_PLACES)
    on = site_membership(nuke, np.array([657.0, 657.0]), np.array([-753.0, -753.0]), np.array([-400.0, -700.0]))
    assert on["A"].tolist() == [True, False] and on["B"].tolist() == [False, True]


def test_engage_needs_three_t_for_16_frames():
    assert engagement(_put(_ctx(), [0, 1, 2], 0, 0, 40, 16)) == (40.0, "A")
    assert engagement(_put(_ctx(), [0, 1, 2], 0, 0, 40, 15)) == (None, None)
    assert engagement(_put(_ctx(), [0, 1], 0, 0, 40, 16)) == (None, None)
    ctx = _put(_ctx(), [0, 1, 2], 0, 0, 40, 16)
    ctx.t_alive[:, 2] = False
    assert engagement(ctx) == (None, None)


@pytest.mark.parametrize("fps", [16, 32])
def test_engage_and_pressure_last_one_second_at_any_frame_rate(fps):
    # 1 s de présence : prise et pression, à 16 comme à 32 images/s ; une demi-seconde (quelques images de plus) : rien
    assert engagement(_put(_ctx(fps=fps), [0, 1, 2], 0, 0, 40, fps)) == (40.0, "A")
    assert pressure(_put(_ctx(fps=fps), [0, 1], 0, 0, 40, fps)) == (40.0, "A")
    assert engagement(_put(_ctx(fps=fps), [0, 1, 2], 0, 0, 40, fps // 2 + 2)) == (None, None)
    assert pressure(_put(_ctx(fps=fps), [0, 1], 0, 0, 40, fps // 2 + 2)) == (None, None)


def test_engage_starts_after_5_seconds():
    assert engagement(_put(_ctx(), [0, 1, 2], 0, 0, 0, 10 * FPS)) == (5.0, "A")


def test_engage_uses_plant_when_earlier():
    assert engagement(_put(_ctx(plant_tick=30 * 64, plant_site="B"), [0, 1, 2], 0, 0, 50, 16)) == (30.0, "B")
    assert engagement(_put(_ctx(plant_tick=30 * 64, plant_site="B"), [0, 1, 2], 0, 0, 20, 16)) == (20.0, "A")
    assert engagement(_ctx(plant_tick=30 * 64, plant_site="B", places=None)) == (30.0, "B")


def test_engage_on_t_death_with_support():
    def ctx(death_s=45.0, place="BombsiteA", support=True, **kw):
        c = _ctx(deaths=[TDeath(int(death_s * 64), 0, place)], **kw)
        _put(c, [0], 0, 0, death_s, 16)
        if support:
            _put(c, [1], 500, 0, death_s, 16)
        return c
    assert engagement(ctx()) == (45.0, "A")
    assert engagement(ctx(support=False)) == (None, None)
    assert engagement(ctx(death_s=4.0)) == (None, None)
    assert engagement(ctx(place="Mid")) == (None, None)
    assert engagement(ctx(places=None)) == (None, None)
    assert engagement(_put(ctx(), [0, 1, 2], 0, 0, 30, 16)) == (30.0, "A")


def test_engage_ignores_events_after_round_end():
    """Pose ou T tué pendant le délai de fin de round (après end_tick) : pas une prise du site."""
    end = 50 * 64
    assert engagement(_ctx(end_tick=end, plant_tick=55 * 64, plant_site="A")) == (None, None)
    assert engagement(_ctx(end_tick=end, plant_tick=50 * 64, plant_site="A")) == (50.0, "A")
    late = _ctx(end_tick=end, end_reason="ct_killed", deaths=[TDeath(55 * 64, 0, "BombsiteA")])
    _put(late, [0], 0, 0, 55, 16)
    _put(late, [1], 500, 0, 55, 16)
    assert engagement(late) == (None, None)
    r = classify_t_round(_ctx(end_tick=end, end_reason="ct_killed", plant_tick=55 * 64, plant_site="A"))
    assert r["plant_s"] == 55.0 and r["engage_s"] is None and r["default_kind"] == "duels"


def _late_rush(take_s=None, spread=False):
    ctx = _ctx(contact_tick=10 * 64)
    _put(ctx, [0, 1, 2], 900, 0, 10, 20 * FPS)        # à 900 u de A (n_site = 3), mais le lieu le plus proche est Ramp
    if spread:
        _put(ctx, [0], 0, 2500, 8, 1)
        _put(ctx, [1], 0, -2500, 8, 1)
    if take_s is not None:
        _put(ctx, [0, 1, 2], 0, 0, take_s, 16)
    return classify_t_round(ctx)


def test_late_rush_becomes_default():
    r = _late_rush(60)
    assert r["category"] == "default" and r["default_kind"] == "take" and r["late_exec"] is False
    assert r["engage_s"] == 60.0 and r["engage_site"] == "A" and r["near_site"] == 3
    r = _late_rush(45)
    assert r["category"] == "rush" and r["default_kind"] is None
    assert _late_rush(50)["category"] == "rush"   # prise à 50 s pile : encore un rush
    assert _late_rush()["category"] == "rush"
    assert _late_rush(60, spread=True)["category"] == "default"
    assert _late_rush(45, spread=True)["category"] == "split"


def _exec_ctx(nades):
    return _put(_ctx(nades=nades), [0, 1, 2], 0, 0, 60, 16)


def test_default_kind_exec_take():
    good = [_nade(46, 100, 0), _nade(50, 100, 0, "flash"), _nade(62, 100, 0)]
    r = classify_t_round(_exec_ctx(good))
    assert r["category"] == "default" and r["default_kind"] == "exec" and r["late_exec"] is True and r["plant_s"] is None
    for first in (_nade(44, 100, 0), _nade(46, 1000, 0), _nade(46, 100, 0, "decoy"), _nade(44, 100, 0, det=46)):
        r = classify_t_round(_exec_ctx([first, *good[1:]]))
        assert r["category"] == "default" and r["default_kind"] == "take" and r["late_exec"] is False
    assert classify_t_round(_exec_ctx([*good[:2], _nade(64, 100, 0)]))["default_kind"] == "take"   # après t_c + 3 s
    # la fenêtre porte sur l'heure de lancer, pas sur l'éclatement
    assert classify_t_round(_exec_ctx([_nade(46, 100, 0, det=50), *good[1:]]))["default_kind"] == "exec"


def test_default_kind_falls_back_to_site_centre():
    nades = [_nade(46, 100, 0), _nade(50, 100, 0, "flash"), _nade(62, 100, 0)]
    r = classify_t_round(_ctx(nades=nades, plant_tick=60 * 64, plant_site="A", places=_places({"Mid": (2000.0, 0.0, 0.0)})))
    assert r["category"] == "default" and r["engage_s"] == 60.0 and r["default_kind"] == "exec"
    r = classify_t_round(_ctx(nades=nades, plant_tick=60 * 64, plant_site="A", sites={}, places=None))
    assert r["category"] == "default" and r["default_kind"] == "take"


def test_default_kind_without_engagement():
    for reason in ("t_killed", "ct_killed", None):
        r = classify_t_round(_ctx(end_reason=reason))
        assert r["category"] == "default" and r["default_kind"] == "duels" and r["engage_s"] is None
        assert r["engage_site"] is None
    assert classify_t_round(_ctx(end_reason="time_ran_out"))["default_kind"] == "no_take"
    for buy in ("eco", "semi"):
        r = classify_t_round(_ctx(buy=buy))
        assert r["category"] == "eco" and r["default_kind"] is None and r["late_exec"] is False


def test_pressure_grenades_and_presence():
    assert pressure(_ctx(nades=[_nade(20, 4000, 300), _nade(23, 4000, 300)])) == (23.0, "B")
    assert pressure(_ctx(nades=[_nade(20, 4000, 300), _nade(26, 4000, 300)])) == (None, None)
    assert pressure(_ctx(nades=[_nade(20, 4000, 300), _nade(25, 4000, 300)])) == (25.0, "B")   # 5 s pile
    # heure d'éclatement, pas de lancer
    assert pressure(_ctx(nades=[_nade(18, 4000, 300, det=24), _nade(22, 4000, 300, det=23.5)])) == (24.0, "B")
    assert pressure(_ctx(nades=[_nade(20, 4000, 300), _nade(23, 4000, 300, det=27)])) == (None, None)
    assert pressure(_ctx(nades=[_nade(20, 4000, 300, det_none=True), _nade(22, 4000, 300, det_none=True)])) == (22.0, "B")
    early = [TNade("smoke", 320, 320, 4000.0, 300.0, 0.0), TNade("smoke", 640, 640, 4000.0, 300.0, 0.0)]
    assert pressure(_ctx(t0=640, nades=early)) == (None, None)        # la 1re grenade éclate avant la fin du freeze time
    assert pressure(_put(_ctx(), [0, 1], 400, 0, 30, 16)) == (30.0, "A")
    assert pressure(_put(_ctx(), [0, 1], 400, 0, 30, 15)) == (None, None)
    dead = _put(_ctx(), [0, 1], 400, 0, 30, 16)
    dead.t_alive[:, 1] = False   # un T mort près du site ne compte pas
    assert pressure(dead) == (None, None)
    planted = _ctx(plant_tick=25 * 64, plant_site="A", nades=[_nade(26, 4000, 300), _nade(28, 4000, 300)])
    assert pressure(_put(planted, [0, 1], 400, 0, 30, 16)) == (None, None)
    both = _ctx(nades=[_nade(20, 4000, 300), _nade(23, 4000, 300)])
    assert pressure(_put(both, [0, 1], 400, 0, 18, 16)) == (18.0, "A")


def _rot_ctx(start=(500, 0), to=(2800, 0), at_s=28, **kw):
    ctx = _ctx(**kw)
    _put(ctx, [0], start[0], start[1], 0, at_s * FPS, side="ct")
    _put(ctx, [0], to[0], to[1], at_s, side="ct")
    return ctx


def test_ct_rotation():
    assert ct_rotation(_rot_ctx(), 20.0, "B") == 28.0
    assert ct_rotation(_rot_ctx(to=(2000, 0)), 20.0, "B") is None      # s'arrête à 2 000 u de B
    assert ct_rotation(_rot_ctx(start=(-1500, 0)), 20.0, "B") is None  # ne tenait pas A
    assert ct_rotation(_rot_ctx(at_s=36), 20.0, "B") is None           # arrive après 35 s
    dead = _rot_ctx()
    dead.ct_alive[20 * FPS:, 0] = False
    assert ct_rotation(dead, 20.0, "B") is None
    assert ct_rotation(_rot_ctx(sites={"A": SITES["A"]}), 20.0, "B") is None
    assert ct_rotation(_rot_ctx(), None, None) is None
    assert ct_rotation(_rot_ctx(at_s=35), 20.0, "B") == 35.0
    near = {"A": (0.0, 0.0, 0.0), "B": (2000.0, 0.0, 0.0)}   # mesurable, mais un CT peut se tenir entre les deux
    assert ct_rotation(_rot_ctx(start=(1000, 0), to=(1350, 0), sites=dict(near)), 20.0, "B") is None   # gagne 350 u
    assert ct_rotation(_rot_ctx(start=(-500, 0), to=(1100, 0), sites=dict(near)), 20.0, "B") is None   # encore sur A
    assert ct_rotation(_rot_ctx(start=(-500, 0), to=(1500, 0), sites=dict(near)), 20.0, "B") == 28.0


def test_rotation_needs_distinct_sites():
    """Rotation mesurable seulement si les centres de A et B sont à plus de ROT_FROM_R (Nuke : sites superposés)."""
    close = {"A": (0.0, 0.0, 0.0), "B": (1000.0, 0.0, 0.0)}
    assert rotation_measurable(SITES) is True
    assert rotation_measurable(close) is False
    assert rotation_measurable({"A": SITES["A"]}) is False and rotation_measurable({}) is False
    stacked = {"A": (0.0, 0.0, 0.0), "B": (0.0, 0.0, -300.0)}   # 600 u avec la métrique 2·dz de _dist
    assert rotation_measurable(stacked) is False
    assert rotation_measurable({"A": (0.0, 0.0, None), "B": (1301.0, 0.0, None)}) is True
    assert rotation_measurable({"A": (0.0, 0.0, None), "B": (1300.0, 0.0, None)}) is False   # « plus de » 1 300 u
    # le CT quitte A (à 500 u) pour arriver à 400 u de B : une rotation si les sites étaient éloignés, rien ici
    moved = _rot_ctx(start=(-500, 0), to=(1400, 0), sites=dict(close))
    assert ct_rotation(moved, 20.0, "B") is None
    far = _rot_ctx(start=(-500, 0), to=(1400, 0), sites={"A": (0.0, 0.0, 0.0), "B": (1400.0, 0.0, 0.0)})
    assert ct_rotation(far, 20.0, "B") == 28.0
    r = classify_t_round(_put(_ctx(sites=dict(close)), [0, 1], 1000, 0, 18, 16))
    assert r["pressure_s"] == 18.0 and r["rotation_measurable"] is False and r["ct_rotation_s"] is None
    r = classify_t_round(_put(_rot_ctx(), [0, 1], 4000, 0, 20, 16))
    assert r["pressure_s"] == 20.0 and r["rotation_measurable"] is True and r["ct_rotation_s"] == 28.0


def test_classify_keeps_old_rules():
    def run(**kw):
        return classify_t_round(_ctx(places=None, **kw))
    for buy in ("eco", "semi"):
        assert run(buy=buy)["category"] == "eco"
    rush = classify_t_round(_put(_ctx(places=None, contact_tick=10 * 64), [0, 1, 2], 900, 0, 18, 16))
    assert rush["category"] == "rush" and rush["near_site"] == 3 and rush["site"] == "A" and rush["contact_s"] == 10.0
    nades = [_nade(t, *FAR_T) for t in (20, 22, 24, 26)]
    ex = classify_t_round(_put(_ctx(places=None, contact_tick=30 * 64, nades=nades), [0, 1, 2], 0, 0, 38, 16))
    assert ex["category"] == "execute" and ex["util_before"] == 4
    decoy = [*nades[:3], _nade(27, *FAR_T, kind="decoy")]
    ex2 = classify_t_round(_put(_ctx(places=None, contact_tick=30 * 64, nades=decoy), [0, 1, 2], 0, 0, 38, 16))
    assert ex2["util_before"] == 4 and ex2["category"] == "execute"   # le leurre compte dans util_before
    late = run(contact_tick=40 * 64)
    assert late["category"] == "default"
    sp = _put(_ctx(places=None, contact_tick=10 * 64), [0, 1, 2], 900, 0, 18, 16)
    _put(sp, [0], 0, 2500, 8, 1)
    _put(sp, [1], 0, -2500, 8, 1)
    split = classify_t_round(sp)
    assert split["category"] == "split"
    fake = run(plant_tick=60 * 64, plant_site="A", nades=[_nade(t, 4000, 300) for t in (25, 30, 35)])
    assert fake["category"] == "fake" and fake["default_kind"] is None and fake["plant_s"] == 60.0
    for r in (rush, ex, ex2, late, split, fake):
        assert set(r) == KEYS
        assert r["category"] == "default" or r["late_exec"] is False
