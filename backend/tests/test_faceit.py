# backend/tests/test_faceit.py
"""Scouting FACEIT : client (cache, nouvelles tentatives), recherche, fiche d'équipe, rattachement des démos, API.
Les réponses de FACEIT sont simulées (tests/fixtures/faceit/team_esea.json), aucun appel réseau."""
import io
import json
from pathlib import Path

import httpx
import pytest

from app.faceit import scout
from app.faceit.client import FaceitClient, FaceitError
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)

FIX = json.loads((Path(__file__).parent / "fixtures" / "faceit" / "team_esea.json").read_text(encoding="utf-8"))
TEAM = FIX["team_id"]
ACTIVE = ["de_ancient", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train"]


def fake_transport(calls: list | None = None, routes: dict | None = None):
    routes = routes or FIX["routes"]

    def handle(req: httpx.Request) -> httpx.Response:
        path = req.url.path.removeprefix("/data/v4")
        if calls is not None:
            calls.append(path)
        if path == "/games/cs2":
            return httpx.Response(200, json={"game_id": "cs2"})
        if path not in routes:
            return httpx.Response(404, json={"errors": []})
        return httpx.Response(200, json=routes[path])
    return httpx.MockTransport(handle)


@pytest.fixture
def fc(tmp_path):
    calls: list = []
    c = FaceitClient("k", tmp_path / "cache", transport=fake_transport(calls), sleep=lambda s: None)
    c.calls = calls
    yield c
    c.close()


def test_client_caches_retries_and_404(tmp_path):
    hits = {"n": 0}

    def handle(req):
        hits["n"] += 1
        if hits["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "1"})
        if req.url.path.endswith("/missing"):
            return httpx.Response(404)
        return httpx.Response(200, json={"ok": hits["n"]})
    slept = []
    c = FaceitClient("k", tmp_path, transport=httpx.MockTransport(handle), sleep=slept.append)
    assert c.get("/x") == {"ok": 2} and slept == [1.0]   # 429 puis succès, en respectant Retry-After
    assert c.get("/x") == {"ok": 2} and hits["n"] == 2   # servi par le cache
    assert c.get("/x", ttl=0) == {"ok": 3}               # cache expiré
    with pytest.raises(FaceitError) as e:
        c.get("/missing")
    assert e.value.status == 404


def test_search_by_link_name_and_player(fc):
    assert [t["team_id"] for t in scout.search(fc, f"https://www.faceit.com/fr/teams/{TEAM}")] == [TEAM]
    res = scout.search(fc, "n1")
    # pseudo d'un joueur : son équipe de championnat (2 matchs ESEA), avant les résultats par nom
    assert res[0]["team_id"] == TEAM and res[0]["via"] == "player" and res[0]["esea_matches"] == 2
    assert res[0]["matches"] == 3  # + FACEIT Club League ; le matchmaking est ignoré


def test_team_overview_esea(fc):
    d = scout.team_overview(fc, TEAM, "esea", map_names={"Mirage": "de_mirage", "Inferno": "de_inferno"},
                            active_maps=ACTIVE)
    assert d["team"]["name"] == "Les Ours"
    ms = d["matches"]
    assert [m["match_id"] for m in ms] == [FIX["matches"]["m1"], FIX["matches"]["m2"]]  # ESEA seulement, récents d'abord
    assert ms[0]["won"] is True and ms[0]["maps"] == [{"map": "de_mirage", "score": [13, 9], "won": True}]
    assert ms[1]["won"] is False and ms[1]["maps"][0]["score"] == [10, 13] and ms[1]["opponent"]["name"] == "Autres"
    assert ms[0]["demos"] == 1 and ms[1]["demos"] == 0
    assert d["record"] == {"played": 2, "won": 1}
    pool = {e["map"]: e for e in d["map_pool"]}
    assert pool["de_mirage"]["played"] == 1 and pool["de_mirage"]["won"] == 1 and pool["de_mirage"]["faceit"]["matches"] == 10
    assert pool["de_inferno"]["rounds_lost"] == 13 and not pool["de_inferno"]["likely_ban"]
    assert pool["de_nuke"]["likely_ban"] and pool["de_train"]["likely_ban"]
    assert {p["nickname"] for p in d["roster"]} == {"n1", "n2", "n3", "n4", "n5"}
    p1 = next(p for p in d["roster"] if p["nickname"] == "n1")
    assert p1["elo"] == 2050 and p1["steamid"] == FIX["steam"][FIX["players"][0]] and p1["matches"] == 2
    # le remplaçant a joué un match : il est dans les steamids du match (rattachement des démos)
    assert FIX["steam"]["aaaaaaaa-0000-0000-0000-000000000009"] in ms[1]["steamids"]


def test_team_overview_all_scope_and_cache(fc):
    d = scout.team_overview(fc, TEAM, "all", active_maps=ACTIVE)
    assert {m["match_id"] for m in d["matches"]} == set(FIX["matches"].values())  # + club league + pug à 3
    n = len(fc.calls)
    scout.team_overview(fc, TEAM, "all", active_maps=ACTIVE)
    assert len(fc.calls) == n  # tout vient du cache


def remote_room(mid: str) -> str:
    return f"https://www.faceit.com/fr/cs2/room/{mid}"


def _patch_api(monkeypatch, tmp_path):
    from app.api import faceit as api
    monkeypatch.setattr(api, "FaceitClient", lambda key, cache: FaceitClient(key, tmp_path / "fc", transport=fake_transport(),
                                                                             sleep=lambda s: None))


def test_api_config_and_team_links_demos(client, monkeypatch):
    c, tmp = client
    _patch_api(monkeypatch, tmp)
    monkeypatch.delenv("SKYBOX_FACEIT_API_KEY", raising=False)
    monkeypatch.delenv("FACEIT_API_KEY", raising=False)
    assert c.get("/api/faceit/status").json()["configured"] is False
    assert c.get(f"/api/faceit/teams/{TEAM}").status_code == 409
    assert c.put("/api/faceit/config", json={"api_key": "court"}).status_code == 400
    r = c.put("/api/faceit/config", json={"api_key": "0f3c1b5e-1111-2222-3333-444455556666"})
    assert r.status_code == 200 and r.json() == {"configured": True, "source": "app", "can_configure": True, "downloads": False}
    assert c.put("/api/faceit/config", json={"downloads": True}).json()["downloads"] is True
    assert "0f3c1b5e" not in c.get("/api/faceit/status").text

    # une démo de la bibliothèque dont un côté compte 3 joueurs de l'équipe FACEIT
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    from sqlalchemy import select

    from app.storage.models import Match, MatchPlayer
    with c.app.state.session_factory() as db:
        m = db.scalar(select(Match))
        demo_id = m.demo_id
        steamids = list(db.scalars(select(MatchPlayer.steamid).where(MatchPlayer.match_id == m.id,
                                                                     MatchPlayer.team_id == m.team_a_id)))[:3]
    routes = json.loads(json.dumps(FIX["routes"]))
    for i, sid in enumerate(steamids):
        routes[f"/players/{FIX['players'][i]}"]["games"]["cs2"]["game_player_id"] = sid
    from app.api import faceit as api
    monkeypatch.setattr(api, "FaceitClient", lambda key, cache: FaceitClient(key, tmp / "fc2", transport=fake_transport(routes=routes),
                                                                             sleep=lambda s: None))
    d = c.get(f"/api/faceit/teams/{TEAM}").json()
    assert d["team"]["name"] == "Les Ours" and d["local_team_id"] is not None
    assert sum(p["in_library"] for p in d["roster"]) == 3
    teams = {t["name"]: t for t in c.get("/api/scouting/teams").json()}
    assert "Les Ours" in teams and teams["Les Ours"]["id"] == d["local_team_id"]
    assert c.get("/api/faceit/teams").json()[0]["local_team_id"] == d["local_team_id"]
    # ré-analyse : le rattachement est refait à l'import
    c.post(f"/api/demos/{demo_id}/reparse")
    wait_ready(c)
    assert "Les Ours" in {t["name"] for t in c.get("/api/scouting/teams").json()}


def test_api_import_match_starts_downloads(client, monkeypatch):
    c, tmp = client
    _patch_api(monkeypatch, tmp)
    monkeypatch.setenv("SKYBOX_FACEIT_API_KEY", "0f3c1b5e-1111-2222-3333-444455556666")
    from app.ingest import remote
    started = []
    monkeypatch.setattr(remote, "download", lambda dl, dest, key: started.append((dl.demo_index, dl.faceit_match)) or [])
    m1, m2 = FIX["matches"]["m1"], FIX["matches"]["m2"]
    assert c.post(f"/api/faceit/matches/{m2}/import").status_code == 409  # pas de démo
    assert c.post("/api/faceit/matches/pas-un-id/import").status_code == 400
    r = c.post(f"/api/faceit/matches/{m1}/import")
    assert r.status_code == 200 and r.json()[0]["faceit_match"] == m1
    # sans accès Downloads : lien du bouton « Télécharger la démo » collé par l'utilisateur
    monkeypatch.setattr(remote, "check_url", lambda u: u)
    link = "https://demos-europe.faceit-cdn.net/cs2/" + m2 + "-1-1.dem.gz?sig=x"
    r = c.post(f"/api/faceit/matches/{m2}/import", json={"url": link})
    assert r.status_code == 200 and r.json()[0]["faceit_match"] == m2
    assert c.post(f"/api/faceit/matches/{m2}/import", json={"url": remote_room(m2)}).status_code == 400
    assert started[-1] == (0, m2)
    from app.api import demos
    demos._downloads.clear()  # liste globale du processus : ne pas la laisser aux autres tests


def test_manual_upload_with_faceit_name_is_linked_to_match(client):
    c, _ = client
    m1 = FIX["matches"]["m1"]
    c.post("/api/demos/upload", files=[("files", (f"{m1}-1-1.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    from app.faceit.link import match_demos
    with c.app.state.session_factory() as db:
        assert match_demos(db, [m1])[m1][0]["status"] == "ready"


def test_esea_competition_names():
    assert scout.is_esea("S59 EU Main B - Regular Season")
    assert scout.is_esea("ESEA S55 EU Intermediate")
    assert scout.is_esea("S58 NA Advanced - Playoffs")
    assert not scout.is_esea("Spielklasse 2 | DACH CS Masters Saison 6")
    assert not scout.is_esea("5v5 RANKED")
