# backend/tests/test_utility.py
"""Utilitaire gâché : grenades restantes par joueur et par round (flashs corrigées par un registre achats − lancers),
trois montants (mort, vivant, fin de mi-temps) et événements (smoke du lurk, ancre seule morte avec sa molotov)."""
import io

import numpy as np

from app.stats.analysis import NADES, _inventory_at, match_analysis
from app.stats.utility import leftover_nades, round_utility
from app.storage.frames_codec import decode_fields
from app.storage.models import Kill, Round, RoundFrames
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

SITES = {"A": (0.0, 0.0, 0.0), "B": (3000.0, 0.0, 0.0)}


def _p(side="T", alive=False, inv=(), carried=0, bought=0, thrown=0, **kw):
    return {"side": side, "alive": alive, "inv": list(inv), "carried_flash": carried, "bought_flash": bought,
            "thrown_flash": thrown, **kw}


def _run(players, number=5, last=23, plant_tick=None):
    return round_utility(number, last, 64, 1000, plant_tick, SITES, players)


def test_two_flashes_bought_none_thrown_one_visible():
    # l'inventaire des images ne montre qu'une flash : le registre en retrouve deux
    assert leftover_nades(["Flashbang"], 0, 2, 0) == ["Flashbang", "Flashbang"]
    out = _run({"a": _p(inv=["Flashbang"], bought=2)})
    assert out["players"]["a"] == {"dead_value": 400, "alive_value": 0, "half_end_value": 0}


def test_flash_ledger_bounds():
    assert leftover_nades(["Flashbang"], 0, 1, 1) == ["Flashbang"]      # l'inventaire fait foi : au moins une
    assert leftover_nades(["Flashbang"], 0, 2, 1) == ["Flashbang"]       # une lancée sur deux achetées
    assert leftover_nades(["Flashbang"], 1, 2, 0) == ["Flashbang", "Flashbang"]  # une gardée + deux achetées : jamais plus de deux
    assert leftover_nades(["Flashbang"], 0, 0, 3) == ["Flashbang"]       # registre négatif : au moins celle de l'inventaire
    assert leftover_nades([], 0, 3, 1) == []                             # aucune flash visible : plus aucune, malgré le registre
    assert leftover_nades([], 1, 2, 0) == []


def test_thrown_smoke_is_not_left():
    # la smoke gardée du round précédent puis lancée n'est plus dans l'inventaire à la mort
    assert _run({"a": _p(inv=["AK-47", "Knife"])})["players"]["a"]["dead_value"] == 0
    assert _run({"a": _p(inv=["Smoke Grenade", "Molotov"])})["players"]["a"]["dead_value"] == NADES["Smoke Grenade"] + NADES["Molotov"]


def test_survivor_split_alive_vs_half_end():
    p = {"a": _p(alive=True, inv=["Smoke Grenade"]), "b": _p(alive=False, inv=["Smoke Grenade"])}
    mid = _run(p, number=5)["players"]
    assert mid["a"] == {"dead_value": 0, "alive_value": 300, "half_end_value": 0}
    assert mid["b"] == {"dead_value": 300, "alive_value": 0, "half_end_value": 0}
    assert _run(p, number=12)["players"]["a"] == {"dead_value": 0, "alive_value": 0, "half_end_value": 300}
    assert _run(p, number=24, last=27)["players"]["a"]["half_end_value"] == 300
    assert _run(p, number=23, last=23)["players"]["a"]["half_end_value"] == 300  # dernier round du match
    assert _run(p, number=13)["players"]["a"]["alive_value"] == 300


def test_lurk_smoke_event():
    far = _p(alive=True, inv=["Smoke Grenade"], mate_d=1200.0, alive_40=True, inv_40=["Smoke Grenade"], tick_40=1000 + 40 * 64)
    out = _run({"a": far, "b": {**far, "mate_d": 500.0}, "c": {**far, "alive_40": False},
                "d": {**far, "inv_40": ["Flashbang"]}, "e": {**far, "side": "CT"}})
    assert out["events"] == [{"round": 5, "kind": "lurk_smoke", "steamid": "a", "tick": 1000 + 40 * 64}]


def test_lone_anchor_molotov_event():
    anchor = _p(side="CT", inv=["Molotov"], death_tick=3000, death_pos=(300.0, 200.0, 0.0), ct_d=None)
    out = _run({"a": anchor})
    assert out["events"] == [{"round": 5, "kind": "lone_anchor_molotov", "steamid": "a", "tick": 3000}]
    assert _run({"a": {**anchor, "ct_d": 700.0}})["events"] == []                      # un CT à moins de 800 u
    assert _run({"a": {**anchor, "ct_d": 900.0}})["events"] != []                      # assez loin : seul
    assert _run({"a": {**anchor, "death_pos": (1500.0, 0.0, 0.0)}})["events"] == []    # loin des deux sites
    assert _run({"a": anchor}, plant_tick=2500)["events"] == []                        # mort après la pose
    assert _run({"a": {**anchor, "inv": ["Smoke Grenade"]}})["events"] == []           # pas de molotov
    assert _run({"a": {**anchor, "inv": ["Incendiary Grenade"]}})["events"] != []
    assert _run({"a": {**anchor, "side": "T"}})["events"] == []


def test_empty_players():
    assert _run({}) == {"players": {}, "events": []}


def _import(c):
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    return wait_ready(c)[0]["match_id"]


def test_analysis_utility_block(client):  # noqa: F811
    c, _ = client
    mid = _import(c)
    with c.app.state.session_factory() as db:
        a = match_analysis(db, mid)
        # ancien calcul : inventaire à la mort, une seule flash
        old = 0
        for r in db.query(Round).filter(Round.match_id == mid):
            fr = db.get(RoundFrames, r.id)
            if fr is None:
                continue
            ff = decode_fields(fr.blob, ("flags",))
            col = {sid: j for j, sid in enumerate(ff.players)}
            cells = []
            for k in db.query(Kill).filter(Kill.round_id == r.id, Kill.tick <= r.end_tick):
                i = int(np.searchsorted(ff.ticks, k.tick, "left")) - 1
                if i >= 0 and k.victim in col:
                    cells.append((i, col[k.victim]))
            if cells:
                weapons, inv = _inventory_at(fr.blob, cells)
                old += sum(NADES.get(weapons[w], 0) for v in inv.values() for w in v)
    u = a["utility"]
    assert set(u) == {"players", "events", "rounds"}
    new_dead = sum(v["dead_value"] for v in u["players"].values())
    assert new_dead >= old and new_dead == sum(d["unused_utility"] for d in a["deaths"])
    assert all(set(v) == {"dead_value", "alive_value", "half_end_value"} for v in u["players"].values())
    assert all(set(e) == {"round", "kind", "steamid", "tick"} and e["kind"] in ("lurk_smoke", "lone_anchor_molotov") for e in u["events"])
    assert all("kept_utility" in t for t in a["economy"]["teams"].values())
    assert sum(t["kept_utility"] for t in a["economy"]["teams"].values()) == sum(
        v["alive_value"] + v["half_end_value"] for v in u["players"].values())


def test_wasted_utility_metric(client):  # noqa: F811
    from app.stats.debrief import METRICS, team_match_metrics
    assert METRICS["wasted_utility"]["better"] == "down" and METRICS["wasted_utility"]["ref"] == 0.53 and "utility_death" in METRICS
    c, _ = client
    mid = _import(c)
    with c.app.state.session_factory() as db:
        a = match_analysis(db, mid)
        team = a["players"][0]["team_id"]
        mine = [e for e in a["utility"]["rounds"] if e["team_id"] == team]
        m = team_match_metrics(db, mid, team, a)["wasted_utility"]
    assert m["n"] == len(mine) > 0 and m["k"] == sum(e["value"] > 0 for e in mine)
    assert m["bad"] == sorted({e["round"] for e in mine if e["value"] > 0})
