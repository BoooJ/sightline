"""Calendrier synchronisé depuis PRACC (n8n W1) et FACEIT (n8n W6), prép d'avant-match (n8n W5)."""
import time
from datetime import datetime, timedelta, timezone

import httpx

from app.api import integrations as integrations_api
from app.faceit.client import FaceitClient
from app.faceit.client import FaceitError
from app.integrations import faceit_agenda, faceit_demos, map_odds
from app.storage.models import CalendarEvent, Match, User
from tests.test_api import client  # noqa: F401  (fixture)
from tests.test_integrations_import import _analysed, tool  # noqa: F401  (fixture)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")


def _sync(c, h, events):
    return c.post("/api/integrations/calendar", headers=h, json={"source": "pracc", "events": events})


def test_calendar_sync_follows_pracc(tool):  # noqa: F811
    c, h, _ = tool
    soon = datetime.now(timezone.utc) + timedelta(days=3)
    esea = {"external_id": "event-1", "kind": "match", "title": "ESEA vs. mskLANERS", "opponent": "mskLANERS",
            "starts_at": "2030-10-28T20:30:00+01:00", "notes": "Competition: S59 EU Main B"}
    prac = {"external_id": "match-9", "kind": "scrim", "title": "Prac vs. Rivals", "opponent": "Rivals", "starts_at": _iso(soon)}
    assert _sync(c, h, [esea, prac, {"external_id": "", "title": "sans id", "starts_at": _iso(soon)},
                        {"external_id": "x", "title": "", "starts_at": _iso(soon)},
                        {"external_id": "y", "title": "date illisible", "starts_at": "demain"}]).json() == \
        {"created": 2, "updated": 0, "removed": 0, "moved": []}
    with c.app.state.session_factory() as db:
        row = db.query(CalendarEvent).filter(CalendarEvent.external_id == "event-1").one()
        assert row.starts_at == datetime(2030, 10, 28, 19, 30) and row.source == "pracc"  # stocké en UTC
        row.announced_at = datetime(2030, 1, 1)
        db.commit()
    # prac annulé sur PRACC : retiré ; match déplacé : mis à jour et de nouveau à annoncer
    moved = {**esea, "starts_at": "2030-10-28T21:00:00+01:00"}
    assert _sync(c, h, [moved]).json() == {"created": 0, "updated": 1, "removed": 1, "moved": [
        {"title": "ESEA vs. mskLANERS", "opponent": "mskLANERS", "before": "2030-10-28T19:30:00Z", "after": "2030-10-28T20:00:00Z"}]}
    with c.app.state.session_factory() as db:
        rows = db.query(CalendarEvent).all()
        assert [(r.external_id, r.starts_at, r.announced_at) for r in rows] == [("event-1", datetime(2030, 10, 28, 20, 0), None)]
    # un événement saisi à la main sur le site n'est jamais touché par la synchro
    with c.app.state.session_factory() as db:
        db.add(CalendarEvent(title="Entraînement", kind="practice", starts_at=datetime(2030, 11, 1, 18, 0)))
        db.commit()
    assert _sync(c, h, []).json()["removed"] == 1
    with c.app.state.session_factory() as db:
        assert [r.title for r in db.query(CalendarEvent).all()] == ["Entraînement"]
    assert c.post("/api/integrations/calendar", headers=h, json={"source": "inconnue", "events": []}).status_code == 400
    assert c.post("/api/integrations/calendar", json={"source": "pracc", "events": []}).status_code == 401


def test_upcoming_prep_once_with_history_from_our_side(tool):  # noqa: F811
    c, h, _ = tool
    up = c.post("/api/integrations/upload", headers=h, data={"opponent": ""},
                files={"file": ("prep.dem", b"PBDEMS2\x00prep", "application/octet-stream")}).json()
    _analysed(c, up["demo_id"])
    with c.app.state.session_factory() as db:
        m = db.query(Match).filter(Match.demo_id == up["demo_id"]).one()
        ours = [p.steamid for p in m.players if p.team_id == m.team_b_id][:2]
        db.add_all([User(username=f"j{i}", display_name="J", password_hash="x", steamid=s) for i, s in enumerate(ours)])
        db.commit()
        them, score = m.team_a.name, [m.score_b, m.score_a]
    now = datetime.now(timezone.utc)
    _sync(c, h, [{"external_id": "e-soon", "kind": "match", "title": f"ESEA vs. {them}", "opponent": them,
                  "starts_at": _iso(now + timedelta(hours=10))},
                 {"external_id": "e-later", "kind": "match", "title": "Plus tard", "opponent": them,
                  "starts_at": _iso(now + timedelta(hours=30))},
                 {"external_id": "e-train", "kind": "practice", "title": "Entraînement", "starts_at": _iso(now + timedelta(hours=5))}])
    first = c.post("/api/integrations/upcoming", headers=h, json={}).json()["events"]
    assert [e["title"] for e in first] == [f"ESEA vs. {them}"]  # dans les 24 h, et pas l'entraînement
    ev = first[0]
    assert ev["starts_at"].endswith("Z")
    hist = ev["history"]
    assert [x["score"] for x in hist["matches"]] == [score]  # notre score d'abord
    assert hist["win"] + hist["loss"] + hist["draw"] == 1
    assert ev["their_maps"][0]["count"] == 1 and ev["their_maps"][0]["map"]
    assert c.post("/api/integrations/upcoming", headers=h, json={}).json()["events"] == []  # jamais deux fois
    assert c.post("/api/integrations/upcoming", headers=h, json={"hours": 500}).status_code == 400


US, OLD, CHAMP = "team-us", "team-old", "champ-s59"
STEAM = {"7656001": "p1", "7656002": "p2", "7656003": None}  # le 3e Steam ID n'a pas de compte FACEIT


def _hist(pid, team, champ, days_ago, kind="championship"):
    return {"competition_type": kind, "competition_id": champ, "finished_at": time.time() - days_ago * 86400,
            "teams": {"faction1": {"team_id": team, "nickname": "Into The Horse" if team == US else "Ancienne équipe",
                                   "players": [{"player_id": pid}]},
                      "faction2": {"team_id": "x", "nickname": "Autres", "players": [{"player_id": "z"}]}}}


def _match(mid, opp, when, us=US):
    return {"match_id": mid, "scheduled_at": when, "best_of": 1, "competition_name": "S59 EU Main B - Regular Season",
            "faceit_url": f"https://www.faceit.com/{{lang}}/cs2/room/{mid}",
            "teams": {"faction1": {"faction_id": us, "name": "Into The Horse"}, "faction2": {"faction_id": "t-" + opp, "name": opp}}}


def _faceit_api(monkeypatch, tmp_path, routes, status=200):
    def handle(req: httpx.Request) -> httpx.Response:
        path, q = req.url.path.removeprefix("/data/v4"), dict(req.url.params)
        if status != 200:
            return httpx.Response(status, json={})
        if path == "/players":
            pid = STEAM.get(q.get("game_player_id"))
            return httpx.Response(200, json={"player_id": pid}) if pid else httpx.Response(404, json={})
        if path.startswith("/championships/"):
            return httpx.Response(200, json={"items": routes.get((path, q.get("type")), [])})
        return httpx.Response(200, json=routes[path]) if path in routes else httpx.Response(404, json={})

    monkeypatch.setenv("SKYBOX_FACEIT_API_KEY", "k")
    monkeypatch.setattr(faceit_agenda, "FRESH", 0)  # chaque appel relit FACEIT (en vrai : 5 min de cache)
    monkeypatch.setattr(integrations_api, "FaceitClient", lambda key, cache: FaceitClient(
        key, tmp_path / "fa", transport=httpx.MockTransport(handle), sleep=lambda s: None))


def _utc(ts):
    return datetime.fromtimestamp(ts, timezone.utc).replace(tzinfo=None)


def test_faceit_calendar_follows_our_matches(tool, monkeypatch, tmp_path):  # noqa: F811
    c, h, _ = tool
    sync = lambda: c.post("/api/integrations/faceit-calendar", headers=h)  # noqa: E731
    soon = int(time.time()) + 3 * 86400
    up, live = (f"/championships/{CHAMP}/matches", "upcoming"), (f"/championships/{CHAMP}/matches", "ongoing")
    routes = {
        "/players/p1/history": {"items": [_hist("p1", US, CHAMP, 7), _hist("p1", OLD, "champ-old", 300),
                                          _hist("p1", "pug", "mm", 1, kind="matchmaking")]},
        "/players/p2/history": {"items": [_hist("p2", US, CHAMP, 7)]},
        up: [_match("1-a", "Rivals", soon), _match("1-b", "Autres", soon, us="t-z")],
        live: [],
    }
    _faceit_api(monkeypatch, tmp_path, routes)
    # sans compte lié, on ne sait pas qui nous sommes : rien n'est touché
    assert sync().json() == {"team": None, "created": 0, "updated": 0, "removed": 0, "moved": [], "queued": 0}
    with c.app.state.session_factory() as db:
        db.add_all([User(username=f"f{i}", display_name="F", password_hash="x", steamid=s) for i, s in enumerate(STEAM)])
        # la copie PRACC du même match, à l'ancien horaire
        db.add(CalendarEvent(source="pracc", external_id="event-7", kind="match", title="ESEA vs. Rivals", opponent="Rivals",
                             starts_at=_utc(soon - 86400)))
        db.commit()
    assert sync().json() == {"team": "Into The Horse", "created": 1, "updated": 0, "removed": 0, "moved": [], "queued": 0}
    with c.app.state.session_factory() as db:
        rows = db.query(CalendarEvent).all()
        assert [(e.source, e.external_id, e.title, e.kind, e.opponent) for e in rows] == \
            [("faceit", "1-a", "ESEA vs. Rivals", "match", "Rivals")]  # la copie PRACC est partie
        assert rows[0].starts_at == _utc(soon)
        assert rows[0].notes == "S59 EU Main B - Regular Season\nBO1\nhttps://www.faceit.com/fr/cs2/room/1-a"
        rows[0].announced_at = datetime(2030, 1, 1)
        db.commit()
    # PRACC la renvoie : écartée, FACEIT a l'horaire exact
    pracc = {"external_id": "event-7", "kind": "match", "title": "ESEA vs. Rivals", "opponent": "Rivals",
             "starts_at": datetime.fromtimestamp(soon - 86400, timezone.utc).isoformat()}
    assert _sync(c, h, [pracc]).json()["created"] == 0
    # FACEIT déplace le match : mis à jour, rendu pour Discord, et la prép repartira
    routes[up] = [_match("1-a", "Rivals", soon + 5400)]
    r = sync().json()
    assert r["updated"] == 1 and r["moved"] == [{"title": "ESEA vs. Rivals", "opponent": "Rivals",
                                                 "before": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(soon)),
                                                 "after": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(soon + 5400))}]
    assert sync().json()["moved"] == []  # une seule fois
    with c.app.state.session_factory() as db:
        assert db.query(CalendarEvent).one().announced_at is None
    # lancé avant l'heure : toujours au calendrier ; annulé : retiré
    routes[up], routes[live] = [], [_match("1-a", "Rivals", soon + 5400)]
    assert sync().json()["removed"] == 0
    routes[live] = []
    assert sync().json()["removed"] == 1


def test_faceit_calendar_errors_leave_calendar_alone(tool, monkeypatch, tmp_path):  # noqa: F811
    c, h, _ = tool
    with c.app.state.session_factory() as db:
        db.add(User(username="f0", display_name="F", password_hash="x", steamid="7656001"))
        db.add(CalendarEvent(source="faceit", external_id="1-a", kind="match", title="ESEA vs. Rivals", opponent="Rivals",
                             starts_at=datetime(2030, 10, 28, 19, 30)))
        db.commit()
    _faceit_api(monkeypatch, tmp_path, {}, status=401)
    r = c.post("/api/integrations/faceit-calendar", headers=h)
    assert r.status_code == 502 and "refusée" in r.json()["detail"]
    _faceit_api(monkeypatch, tmp_path / "2", {"/players/p1/history": {"items": [_hist("p1", US, CHAMP, 200)]}})
    assert c.post("/api/integrations/faceit-calendar", headers=h).json()["removed"] == 0  # pas de championnat récent
    monkeypatch.delenv("SKYBOX_FACEIT_API_KEY")
    monkeypatch.delenv("FACEIT_API_KEY", raising=False)
    assert c.post("/api/integrations/faceit-calendar", headers=h).status_code == 409
    assert c.post("/api/integrations/faceit-calendar").status_code == 401
    with c.app.state.session_factory() as db:
        assert db.query(CalendarEvent).count() == 1


def _overview(pool: dict, matches: int, team_id: str = "t") -> dict:
    return {"team": {"team_id": team_id, "name": team_id}, "matches": [], "record": {"played": matches},
            "map_pool": [{"map": m, "played": p, "won": w} for m, (p, w) in pool.items()]}


def test_map_odds_estimate():
    active = ["de_ancient", "de_dust2", "de_mirage", "de_nuke"]
    names = {"de_ancient": "Ancient", "de_dust2": "Dust II", "de_mirage": "Mirage", "de_nuke": "Nuke"}
    them = _overview({"de_ancient": (5, 4), "de_mirage": (3, 1), "de_vertigo": (9, 9)}, 8)  # hors pool : ignorée
    us = _overview({"de_ancient": (4, 2), "de_nuke": (6, 3)}, 10)
    o = map_odds.estimate(them, us, active, names)
    # Ancient : jouée des deux côtés ; Nuke (6 de nos 10) devant Mirage (jamais chez nous) ; Dust II : personne
    assert [m["map"] for m in o["maps"]] == ["de_ancient", "de_nuke", "de_mirage", "de_dust2"]
    assert o["maps"][0] == {"map": "de_ancient", "name": "Ancient", "pct": o["maps"][0]["pct"], "played": 5, "won": 4}
    assert o["maps"][0]["pct"] > 40 and 98 <= sum(m["pct"] for m in o["maps"]) <= 102
    assert (o["them"], o["us"], o["few"]) == (8, 10, False)
    # une carte qu'aucune des deux équipes ne joue garde une petite chance, sans passer devant
    assert o["maps"][-1]["pct"] < o["maps"][2]["pct"]
    assert map_odds.estimate(_overview({"de_ancient": (1, 0)}, 1), us, active, names)["few"] is True
    assert map_odds.estimate(_overview({}, 0), us, active, names) is None  # rien de connu chez eux


def test_faceit_calendar_stores_likely_maps(tool, monkeypatch, tmp_path):  # noqa: F811
    c, h, _ = tool
    soon = int(time.time()) + 3 * 3600  # dans la fenêtre de prép (24 h)
    routes = {"/players/p1/history": {"items": [_hist("p1", US, CHAMP, 7)]},
              (f"/championships/{CHAMP}/matches", "upcoming"): [_match("1-a", "Rivals", soon)]}
    _faceit_api(monkeypatch, tmp_path, routes)
    active = sorted(m.name for m in c.app.state.maps.values() if m.active_duty)
    seen: list[str] = []

    def overview(cl, team_id, scope, map_names=None, active_maps=None):
        seen.append(team_id)
        if team_id == "t-Rivals" and len(seen) > 4:
            raise FaceitError("FACEIT est saturé", 503)
        mine = team_id == US
        return _overview({active[0]: (5, 3) if mine else (6, 5), active[1]: (1, 0) if mine else (2, 0)}, 9 if mine else 4)
    monkeypatch.setattr(map_odds.scout, "team_overview", overview)
    monkeypatch.setattr(faceit_demos, "auto", lambda *a, **k: 0)  # import de démos : testé à part
    with c.app.state.session_factory() as db:
        db.add(User(username="f0", display_name="F", password_hash="x", steamid="7656001"))
        db.commit()
    assert c.post("/api/integrations/faceit-calendar", headers=h).json()["created"] == 1
    assert sorted(seen) == ["t-Rivals", US]  # notre fiche et la leur
    with c.app.state.session_factory() as db:
        row = db.query(CalendarEvent).one()
        odds = map_odds.stored(row)
    assert odds["maps"][0]["map"] == active[0] and (odds["them"], odds["us"], odds["few"]) == (4, 9, True)
    assert odds["maps"][0]["played"] == 6 and odds["maps"][0]["won"] == 5
    # recalcul au plus toutes les 6 h ; ensuite, une erreur de FACEIT garde l'estimation précédente
    c.post("/api/integrations/faceit-calendar", headers=h)
    assert len(seen) == 2
    with c.app.state.session_factory() as db:
        row = db.query(CalendarEvent).one()
        row.map_odds_at -= timedelta(hours=7)
        db.commit()
    c.post("/api/integrations/faceit-calendar", headers=h)
    seen.clear()
    seen.extend(["x"] * 4)
    with c.app.state.session_factory() as db:
        row = db.query(CalendarEvent).one()
        row.map_odds_at -= timedelta(hours=7)
        db.commit()
    assert c.post("/api/integrations/faceit-calendar", headers=h).status_code == 200
    with c.app.state.session_factory() as db:
        assert map_odds.stored(db.query(CalendarEvent).one()) == odds
    # la prép (W5) les reprend
    ev = c.post("/api/integrations/upcoming", headers=h, json={}).json()["events"][0]
    assert ev["likely_maps"] == odds
