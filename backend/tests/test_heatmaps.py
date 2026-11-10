# backend/tests/test_heatmaps.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_heatmaps(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    pres = c.get("/api/heatmaps?map=de_nuke").json()
    assert pres["rounds"] == 23 and set(pres["levels"]) == {"upper", "lower"}
    total = sum(cell[2] for lv in pres["levels"].values() for cell in lv)
    assert total > 1000 and all(0 <= cell[0] < pres["grid"] and 0 <= cell[1] < pres["grid"] for cell in pres["levels"]["upper"])
    early = c.get("/api/heatmaps?map=de_nuke&t_to=20").json()
    assert sum(cell[2] for lv in early["levels"].values() for cell in lv) < total
    ctl = c.get("/api/heatmaps?map=de_nuke&kind=control").json()
    assert all(len(cell) == 4 for cell in ctl["levels"]["upper"])
    ct = c.get("/api/heatmaps?map=de_nuke&side=CT").json()
    t = c.get("/api/heatmaps?map=de_nuke&side=T").json()
    sum_ = lambda h: sum(cell[2] for lv in h["levels"].values() for cell in lv)
    assert sum_(ct) + sum_(t) == total
    deaths = c.get("/api/heatmaps?map=de_nuke&kind=deaths").json()
    assert 140 <= len(deaths["points"]) <= 151 and deaths["points"][0]["player"]
    kills_ct = c.get("/api/heatmaps?map=de_nuke&kind=kills&side=CT").json()
    assert all(p["side"] == "CT" for p in kills_ct["points"])
    players = c.get("/api/heatmaps/players?map=de_nuke").json()
    assert len(players) == 10
    one = c.get(f"/api/heatmaps?map=de_nuke&player={players[0]['steamid']}").json()
    assert 0 < sum_(one) < total
    assert c.get("/api/heatmaps?map=de_nope").status_code == 404
    assert c.get("/api/heatmaps?map=de_nuke&kind=x").status_code == 400


def test_heatmap_weapon_filter(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    allk = c.get("/api/heatmaps?map=de_nuke&kind=kills").json()["points"]
    awp = c.get("/api/heatmaps?map=de_nuke&kind=kills&weapon=awp").json()["points"]
    assert 0 < len(awp) < len(allk) and all(p["weapon"] == "awp" for p in awp)


def test_mixed_sample_rates_weigh_by_frame_duration(db, nuke_parsed, nuke_parsed_32, maps):
    """Bibliothèque qui mélange des démos à 16 et à 32 i/s (ré-analyse en cours, ou démo dont le fichier manque et qui
    reste à 16) : chaque image compte pour sa durée, une démo à 32 i/s ne pèse pas double dans la présence et dans la
    carte de contrôle."""
    from app.stats.heatmaps import HeatFilters, heatmap
    from app.storage.models import Demo
    from app.storage.repository import save_parsed_demo

    ids = []
    for i, parsed in enumerate((nuke_parsed, nuke_parsed_32)):
        d = Demo(path=f"/x/{i}.dem", file_name=f"{i}.dem", size=1, sha256=str(i) * 64, status="parsing")
        db.add(d)
        db.flush()
        ids.append(save_parsed_demo(db, d.id, parsed, maps))
    db.commit()
    meta = maps["de_nuke"]
    def cells(h: dict) -> dict:
        return {lv: {(c[0], c[1]): c[2:] for c in cs} for lv, cs in h["levels"].items()}
    for kind in ("presence", "control"):
        at16 = cells(heatmap(db, meta, HeatFilters(map="de_nuke", kind=kind, match=ids[0])))
        at32 = cells(heatmap(db, meta, HeatFilters(map="de_nuke", kind=kind, match=ids[1])))
        both = cells(heatmap(db, meta, HeatFilters(map="de_nuke", kind=kind)))
        assert sum(len(c) for c in at16.values()) > 100
        assert at32 == at16  # même jeu, deux fois plus d'images : même poids
        assert both == {lv: {k: [2 * v for v in vs] for k, vs in c.items()} for lv, c in at16.items()}
