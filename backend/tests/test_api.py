# backend/tests/test_api.py
import io
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import msgpack
import pytest
from fastapi.testclient import TestClient

from app.core.config import ROOT, Settings
from app.main import create_app
from app.parsing.build import build_demo
from app.parsing.extract import load_raw

FIX = Path(__file__).parent / "fixtures" / "nuke_sample"


def fixture_parse(path, sample_rate, build_opts, progress):
    return build_demo(load_raw(FIX))


@pytest.fixture
def client(tmp_path):
    s = Settings(data_dir=tmp_path / "data", maps_dir=ROOT / "maps", frontend_dist=tmp_path / "nodist",
                 demo_folders=[tmp_path / "demos"])
    s._config_path = tmp_path / "config.toml"
    (tmp_path / "demos").mkdir()
    app = create_app(s, parse_fn=fixture_parse, executor_factory=lambda n: ThreadPoolExecutor(n))
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        yield c, tmp_path


def wait_ready(c, timeout=60):
    t = time.time()
    while time.time() - t < timeout:
        demos = c.get("/api/demos").json()
        if demos and all(d["status"] in ("ready", "error") for d in demos):
            return demos
        time.sleep(0.2)
    raise AssertionError("import trop long")


def test_upload_list_match_replay(client):
    c, _ = client
    assert c.get("/api/health").json()["ok"]
    r = c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    assert r.status_code == 200 and r.json()[0]["created"]
    demos = wait_ready(c)
    assert demos[0]["status"] == "ready" and demos[0]["match_id"]
    matches = c.get("/api/matches").json()
    assert len(matches) == 1
    det = c.get(f"/api/matches/{matches[0]['id']}").json()
    assert len(det["rounds"]) == 23
    rep = c.get(f"/api/rounds/{det['rounds'][1]['id']}/replay")
    assert rep.headers["content-type"].startswith("application/msgpack")
    data = msgpack.unpackb(rep.content, raw=False)
    assert data["frames"]["m"] == 10 and data["map_name"] == "de_nuke"
    assert c.get("/api/matches/999").status_code == 404
    assert c.post("/api/demos/upload", files=[("files", ("x.txt", io.BytesIO(b"x"), "text/plain"))]).status_code == 400


def test_scan_reparse_delete(client):
    c, tmp = client
    (tmp / "demos" / "a.dem").write_bytes(b"abc")
    assert len(c.post("/api/demos/scan", json={}).json()) == 1
    demo_id = wait_ready(c)[0]["id"]
    assert c.post(f"/api/demos/{demo_id}/reparse").json()["ok"]
    wait_ready(c)
    assert c.delete(f"/api/demos/{demo_id}").json()["ok"]
    assert c.get("/api/matches").json() == []


def test_maps_and_settings(client):
    c, tmp = client
    names = {m["name"] for m in c.get("/api/maps").json()}
    assert "de_nuke" in names
    assert c.get("/api/maps/de_nuke").json()["scale"] == 7.0
    assert c.get("/maps/de_nuke.png").status_code == 200
    s = c.put("/api/settings", json={"sample_rate": 24, "demo_folders": [str(tmp / "demos")]}).json()
    assert s["sample_rate"] == 24
    assert (tmp / "config.toml").exists()


def test_chunked_upload_resume(client):
    c, tmp = client
    payload = bytes(range(256)) * 40  # 10 240 octets envoyés en 3 morceaux, dans le désordre
    uid = "abcdef0123456789"
    assert c.post("/api/uploads", json={"id": uid, "name": "big.dem", "size": len(payload)}).json()["received"] == 0
    # morceau du milieu d'abord : plage enregistrée, préfixe contigu toujours nul
    r = c.put(f"/api/uploads/{uid}?offset=4000", content=payload[4000:8000]).json()
    assert r["received"] == 0 and r["ranges"] == [[4000, 8000]]
    assert c.put(f"/api/uploads/{uid}?offset=0", content=payload[:4000]).json()["received"] == 8000
    # reprise : le client redemande l'état ; un morceau en double est accepté sans effet
    st = c.post("/api/uploads", json={"id": uid, "name": "big.dem", "size": len(payload)}).json()
    assert st["received"] == 8000 and st["ranges"] == [[0, 8000]]
    assert c.put(f"/api/uploads/{uid}?offset=0", content=payload[:4000]).json()["ranges"] == [[0, 8000]]
    assert c.put(f"/api/uploads/{uid}?offset=10000", content=payload[:4000]).status_code == 409  # dépasse la taille
    assert c.post(f"/api/uploads/{uid}/complete").status_code == 409  # incomplet
    c.put(f"/api/uploads/{uid}?offset=8000", content=payload[8000:])
    res = c.post(f"/api/uploads/{uid}/complete").json()
    assert res["created"] and res["file_name"] == "big.dem"
    assert (tmp / "data" / "uploads" / "big.dem").read_bytes() == payload
    assert wait_ready(c)[0]["status"] == "ready"
    assert c.post("/api/uploads", json={"id": "../../etc", "name": "a.dem"}).status_code == 400
    assert c.post("/api/uploads", json={"id": uid, "name": "a.txt"}).status_code == 400


def test_replay_is_gzipped(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    det = c.get(f"/api/matches/{c.get('/api/matches').json()[0]['id']}").json()
    rep = c.get(f"/api/rounds/{det['rounds'][1]['id']}/replay", headers={"accept-encoding": "gzip"})
    assert rep.headers["content-encoding"] == "gzip"


def test_stats_and_players_api(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    mid = c.get("/api/matches").json()[0]["id"]
    st = c.get(f"/api/matches/{mid}/stats").json()
    assert len(st["players"]) == 10 and len(st["teams"]) == 2
    assert c.get(f"/api/matches/{mid}/stats?side=ct").json()["side"] == "CT"
    assert c.get(f"/api/matches/{mid}/stats?side=x").status_code == 400
    ps = c.get("/api/players").json()
    assert len(ps) == 10 and ps[0]["rating"] >= ps[-1]["rating"] and ps[0]["matches"] == 1
    one = c.get(f"/api/players/{ps[0]['steamid']}").json()
    assert one["kills"] == ps[0]["kills"] and len(one["history"]) == 1 and one["history"][0]["match"]["id"] == mid
    assert c.get("/api/players?map=de_dust2").json() == []
    assert c.get("/api/players/123").status_code == 404


def test_roles_and_economy(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    ps = c.get("/api/players").json()
    assert all(p["roles"]["t"] and p["roles"]["ct"] for p in ps)
    labels = c.get("/api/players/roles").json()
    assert "entry" in labels
    for team in {p["team"] for p in ps}:
        t_roles = [p["roles"]["t"] for p in ps if p["team"] == team]
        assert t_roles.count("entry") == 1 and t_roles.count("lurker") <= 1
    entry = c.get("/api/players?role=entry").json()
    assert len(entry) == 2
    assert c.get("/api/players?role=chef").status_code == 400
    eco = c.get("/api/players?econ=eco").json()
    assert all(p["rounds"] < 23 for p in eco)
    one = c.get(f"/api/players/{ps[0]['steamid']}").json()
    assert set(one["economy"]) >= {"all", "buy", "pistol"} and one["roles"]["t"]
    assert one["economy"]["pistol"]["rounds"] == 2
    assert c.get("/api/players?econ=x").status_code == 400



def test_library_labels_and_filters(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    mid = c.get("/api/matches").json()[0]["id"]
    lab = c.patch(f"/api/matches/{mid}/labels", json={"folder": "Scrims", "event": "Major", "tags": ["anti-eco", " ", "anti-eco", "B"],
                                                     "played_on": "2026-09-01"}).json()
    assert lab == {"folder": "Scrims", "event": "Major", "tags": ["B", "anti-eco"], "played_on": "2026-09-01"}
    assert c.patch(f"/api/matches/{mid}/labels", json={"played_on": "hier"}).status_code == 400
    m = c.get("/api/matches").json()[0]
    assert m["labels"]["folder"] == "Scrims" and m["date"] == "2026-09-01"
    facets = c.get("/api/matches/facets").json()
    assert facets["folders"] == [{"name": "Scrims", "count": 1}] and {"name": "B", "count": 1} in facets["tags"]
    assert len(c.get("/api/matches?folder=Scrims").json()) == 1
    assert c.get("/api/matches?folder=Officiels").json() == []
    assert len(c.get("/api/matches?date_from=2026-08-01&date_to=2026-09-30").json()) == 1
    assert c.get("/api/matches?date_from=2026-10-01").json() == []
    assert c.get("/api/matches?tag=B&event=Major").json()[0]["id"] == mid
    assert c.get("/api/rounds/search?date_from=2026-10-01").json()["total"] == 0
    assert c.get("/api/rounds/search?event=Major").json()["total"] == 23
    assert c.get("/api/players?folder=Officiels").json() == []
    assert len(c.get("/api/players?folder=Scrims").json()) == 10
    sid = c.get("/api/players").json()[0]["steamid"]
    assert c.get(f"/api/players/{sid}?date_from=2026-10-01").status_code == 404
    # survit à une ré-analyse
    demo_id = c.get("/api/demos").json()[0]["id"]
    c.post(f"/api/demos/{demo_id}/reparse")
    wait_ready(c)
    assert c.get("/api/matches").json()[0]["labels"]["event"] == "Major"



def test_player_dashboard(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    ps = c.get("/api/players").json()
    d = c.get(f"/api/players/{ps[0]['steamid']}/dashboard").json()
    assert d["player"]["name"] == ps[0]["name"] and len(d["trend"]) == 1 and d["maps"][0]["map"] == "de_nuke"
    assert sum(w["kills"] for w in d["weapons"]) == ps[0]["kills"]
    assert abs(sum(w["share"] for w in d["weapons"]) - 100) < 1
    assert d["strengths"] and all(x["delta_pct"] > 0 for x in d["strengths"])
    assert all(x["delta_pct"] < 0 for x in d["weaknesses"])
    assert c.get("/api/players/1/dashboard").status_code == 404



def test_static_cache_headers(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html></html>")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)")
    s = Settings(data_dir=tmp_path / "data", maps_dir=ROOT / "maps", frontend_dist=dist)
    with TestClient(create_app(s, parse_fn=fixture_parse, executor_factory=lambda n: ThreadPoolExecutor(n))) as c:
        a = c.get("/assets/index-abc123.js")
        assert a.status_code == 200 and "immutable" in a.headers["cache-control"]
        assert c.get("/matches/1").headers["cache-control"] == "no-cache"
        assert "max-age=604800" in c.get("/maps/de_nuke.png").headers["cache-control"]


def test_spa_route_does_not_leave_dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("INDEX")
    (tmp_path / "secret.txt").write_text("SECRET")
    s = Settings(data_dir=tmp_path / "data", maps_dir=ROOT / "maps", frontend_dist=dist)
    with TestClient(create_app(s, parse_fn=fixture_parse, executor_factory=lambda n: ThreadPoolExecutor(n))) as c:
        for p in ("/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/x/..%2f..%2fsecret.txt"):
            assert "SECRET" not in c.get(p).text


def test_caches_warmed_after_import(client):
    from app.api import players
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    # le préchauffage tourne en arrière-plan, et la version du cache peut changer pendant qu'il tourne (fin d'import) :
    # attendre que les deux entrées existent pour la version courante
    wanted = {("roles", None), ("career", None, None, None, None, None)}  # + opp_econ
    t, ok = time.time(), False
    while time.time() - t < 30 and not ok:
        with c.app.state.session_factory() as db:
            version = players._cache.version(db)
        ok = {(k, version) for k in wanted} <= set(players._cache._d)
        if not ok:
            time.sleep(0.1)
    assert ok


def test_upload_zstd_demo_is_decompressed(client):
    import zstandard

    c, tmp = client
    payload = bytes(range(256)) * 100
    packed = zstandard.ZstdCompressor(level=9).compress(payload)
    uid = "zst0123456789abcd"
    assert c.post("/api/uploads", json={"id": uid, "name": "mouz-vs-vitality-m1-mirage.dem.zst", "size": len(packed)}).status_code == 200
    c.put(f"/api/uploads/{uid}?offset=0", content=packed)
    res = c.post(f"/api/uploads/{uid}/complete").json()
    assert res["file_name"] == "mouz-vs-vitality-m1-mirage.dem"
    assert (tmp / "data" / "uploads" / "mouz-vs-vitality-m1-mirage.dem").read_bytes() == payload
    # contenu .zst invalide : refusé proprement
    bad = "zstbad0123456789ab"
    c.post("/api/uploads", json={"id": bad, "name": "x.dem.zst", "size": 5})
    c.put(f"/api/uploads/{bad}?offset=0", content=b"abcde")
    assert c.post(f"/api/uploads/{bad}/complete").status_code == 400
