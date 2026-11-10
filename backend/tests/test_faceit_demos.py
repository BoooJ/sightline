"""Démos FACEIT d'un adversaire : file d'attente servie à l'extension (n8n W1), import d'office pour chaque nouveau match
FACEIT (W6) et commande /demos du bot Discord. FACEIT et Discord sont simulés, aucun appel réseau."""
import json
import time
from datetime import datetime, timedelta

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.api import discord as discord_api
from app.api import integrations as integrations_api
from app.integrations import faceit_demos, utcnow
from app.storage.models import CalendarEvent, DemoSource, User
from tests.test_api import client  # noqa: F401  (fixture)
from tests.test_integrations_calendar import CHAMP, US, _faceit_api, _hist, _match
from tests.test_integrations_import import tool  # noqa: F401  (fixture)

THEM = "t-Rivals"


def _row(match_id, maps, days_ago, demos=1):
    started = datetime.fromtimestamp(time.time() - days_ago * 86400).isoformat()
    return {"match_id": match_id, "started_at": started, "demos": demos, "opponent": {"name": "Autres"},
            "maps": [{"map": m, "score": [13, 9], "won": True} for m in maps]}


FICHE = {"team": {"team_id": THEM, "name": "Rivals"}, "record": {"played": 4}, "map_pool": [],
         "matches": [_row("1-00000000-0000-4000-8000-000000000001", ["de_nuke"], 2), _row("1-00000000-0000-4000-8000-000000000002", ["de_dust2"], 5), _row("1-00000000-0000-4000-8000-000000000003", ["de_mirage"], 9),
                     _row("1-00000000-0000-4000-8000-000000000004", ["de_dust2"], 12, demos=0)]}


def test_choose_prefers_likely_maps_then_recent(client):  # noqa: F811
    c, _ = client
    with c.app.state.session_factory() as db:
        assert [m["match_id"] for m in faceit_demos.choose(db, FICHE, 2, [])] == ["1-00000000-0000-4000-8000-000000000001", "1-00000000-0000-4000-8000-000000000002"]
        assert [m["match_id"] for m in faceit_demos.choose(db, FICHE, 2, ["de_mirage", "de_dust2"])] == ["1-00000000-0000-4000-8000-000000000003", "1-00000000-0000-4000-8000-000000000002"]
        faceit_demos.enqueue(db, FICHE["team"], [FICHE["matches"][0]], "discord", "Paul")
        # déjà en file, ou sans démo chez FACEIT : jamais proposé
        assert [m["match_id"] for m in faceit_demos.choose(db, FICHE, 5, [])] == ["1-00000000-0000-4000-8000-000000000002", "1-00000000-0000-4000-8000-000000000003"]
        row = db.query(DemoSource).one()
        label = json.loads(row.label)
        assert (row.source, row.external_id, row.status) == ("faceit", "1-00000000-0000-4000-8000-000000000001", "wanted")
        assert label["folder"] == "Scouting FACEIT" and label["tags"] == ["faceit", "Rivals"] and label["by"] == "Paul"


def test_bo3_counts_one_demo_per_map(tool, monkeypatch):  # noqa: F811
    """Un BO3 a une démo par carte jouée : « 1 démo » = une carte, pas les 3 du match."""
    c, h, _ = tool
    started: list = []
    monkeypatch.setattr(integrations_api, "start_download", lambda dl, *a, **k: started.append(dl.url) or {})
    bo3 = _row("1-00000000-0000-4000-8000-0000000000b3", ["de_nuke", "de_mirage", "de_ancient"], 1, demos=3)
    fiche = {**FICHE, "matches": [bo3, *FICHE["matches"]]}
    with c.app.state.session_factory() as db:
        picked = faceit_demos.choose(db, fiche, 1, ["de_mirage"])
        assert [(m["match_id"], m["pick"]) for m in picked] == [(bo3["match_id"], [2])]  # sa carte probable seulement
        assert [(m["match_id"], m["pick"]) for m in faceit_demos.choose(db, fiche, 2, [])] == [(bo3["match_id"], [1, 2])]
        assert sum(len(m["pick"]) for m in faceit_demos.choose(db, fiche, 4, ["de_dust2"])) == 4
        faceit_demos.enqueue(db, fiche["team"], picked, "discord", "Paul")
    assert [w["match_id"] for w in c.post("/api/integrations/faceit-wanted", headers=h).json()["wanted"]] == [bo3["match_id"]]
    # l'extension renvoie le lien de chaque carte (menu « Démo 1, 2, 3 ») : seule la carte demandée est téléchargée
    base = f"https://demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com/cs2/{bo3['match_id']}"
    links = [f"{base}-{k}-1.dem.zst?X-Amz-Signature=abc" for k in (1, 2, 3)]
    r = c.post("/api/integrations/faceit-links", headers=h, json={"match_id": bo3["match_id"], "links": links}).json()
    assert r == {"status": "started", "count": 1} and started == [links[1]]
    # nom de fichier inattendu : l'ordre du menu, qui suit celui des cartes
    assert faceit_demos.keep(["https://x/a.dem", "https://x/b.dem"], bo3["match_id"], {"maps": [2]}) == ["https://x/b.dem"]
    assert faceit_demos.keep(links, bo3["match_id"], {}) == links  # ancienne demande, sans cartes : tout


def test_queue_served_to_extension(tool, monkeypatch):  # noqa: F811
    c, h, _ = tool
    started: list = []
    monkeypatch.setattr(integrations_api, "start_download", lambda dl, *a, **k: started.append((dl.url, dl.faceit_match, k)) or {})
    with c.app.state.session_factory() as db:
        faceit_demos.enqueue(db, FICHE["team"], FICHE["matches"][:2], "auto")
    wanted = lambda: c.post("/api/integrations/faceit-wanted", headers=h).json()["wanted"]  # noqa: E731
    first = wanted()
    assert [w["match_id"] for w in first] == ["1-00000000-0000-4000-8000-000000000001", "1-00000000-0000-4000-8000-000000000002"] and first[0]["url"].endswith("/room/1-00000000-0000-4000-8000-000000000001")
    assert wanted() == []  # pris par un PC : pas proposé à un autre
    links = lambda mid, **b: c.post("/api/integrations/faceit-links", headers=h, json={"match_id": mid, **b}).json()  # noqa: E731
    # pas connecté à FACEIT : la demande attend le prochain passage
    assert links("1-00000000-0000-4000-8000-000000000001", error="login") == {"status": "login"}
    # page sans lien : échec compté, retenté plus tard
    assert links("1-00000000-0000-4000-8000-000000000002", links=["https://evil.example/x.txt"])["status"] == "failed"
    assert [w["match_id"] for w in wanted()] == ["1-00000000-0000-4000-8000-000000000001", "1-00000000-0000-4000-8000-000000000002"]
    url = "https://demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com/cs2/1-00000000-0000-4000-8000-000000000001-1-1.dem.zst?X-Amz-Signature=abc"
    assert links("1-00000000-0000-4000-8000-000000000001", links=[url, url.replace("-1-1.", "-1-4.")]) == {"status": "started", "count": 2}
    assert [(u[-30:], m) for u, m, _ in started] == [(url[-30:], "1-00000000-0000-4000-8000-000000000001"), (url.replace("-1-1.", "-1-4.")[-30:], "1-00000000-0000-4000-8000-000000000001")]
    assert started[0][2]["origin"]["source"] == "faceit"
    assert links("1-00000000-0000-4000-8000-000000000001", links=[url]) == {"status": "ignored"}  # déjà en cours
    # un PC qui ne répond pas (Chrome fermé) : reproposé au bout de 20 min
    with c.app.state.session_factory() as db:
        row = db.query(DemoSource).filter(DemoSource.external_id == "1-00000000-0000-4000-8000-000000000002").one()
        row.updated_at = utcnow() - timedelta(minutes=21)
        db.commit()
    assert [w["match_id"] for w in wanted()] == ["1-00000000-0000-4000-8000-000000000002"]
    assert c.post("/api/integrations/faceit-links", headers=h, json={"match_id": "pas-un-id"}).status_code == 400
    monkeypatch.setattr(faceit_demos, "disk_free", lambda d: 1024)
    assert c.post("/api/integrations/faceit-wanted", headers=h).json() == {"wanted": [], "low_disk": True}
    assert c.post("/api/integrations/faceit-wanted").status_code == 401


def test_new_faceit_match_queues_two_demos_once(tool, monkeypatch, tmp_path):  # noqa: F811
    c, h, _ = tool
    soon = int(time.time()) + 3 * 86400
    routes = {"/players/p1/history": {"items": [_hist("p1", US, CHAMP, 7)]},
              (f"/championships/{CHAMP}/matches", "upcoming"): [_match("1-a", "Rivals", soon)]}
    _faceit_api(monkeypatch, tmp_path, routes)
    monkeypatch.setattr(faceit_demos.scout, "team_overview", lambda cl, tid, *a, **k: FICHE if tid == THEM else
                        {**FICHE, "team": {"team_id": tid, "name": "Nous"}, "matches": []})
    with c.app.state.session_factory() as db:
        db.add(User(username="f0", display_name="F", password_hash="x", steamid="7656001"))
        db.commit()
    assert c.post("/api/integrations/faceit-calendar", headers=h).json()["queued"] == 2
    assert c.post("/api/integrations/faceit-calendar", headers=h).json()["queued"] == 0  # une seule fois par match
    with c.app.state.session_factory() as db:
        assert sorted(r.external_id for r in db.query(DemoSource)) == ["1-00000000-0000-4000-8000-000000000001", "1-00000000-0000-4000-8000-000000000002"]
        assert db.query(CalendarEvent).one().demos_requested_at is not None


def _keys():
    k = Ed25519PrivateKey.generate()
    return k, k.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()


def _signed(c, key, payload, ts=None, bad=False):
    body = json.dumps(payload).encode()
    ts = str(int(time.time()) if ts is None else ts)
    sig = key.sign(ts.encode() + body).hex()
    if bad:
        sig = ("0" if sig[0] != "0" else "1") + sig[1:]
    return c.post("/api/discord/interactions", content=body,
                  headers={"X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts, "Content-Type": "application/json"})


def test_discord_bot_config_and_interactions(client, monkeypatch):  # noqa: F811
    c, _ = client
    key, public = _keys()
    assert c.put("/api/discord/config", json={"app_id": "123", "public_key": public}).status_code == 400
    assert c.put("/api/discord/config", json={"app_id": "1234567890123456789", "public_key": "zz"}).status_code == 400
    calls: list = []

    class Resp:
        status_code = 200

    monkeypatch.setattr(discord_api.httpx, "put", lambda url, **k: calls.append((url, k)) or Resp())
    token = "x" * 72
    r = c.put("/api/discord/config", json={"app_id": "1234567890123456789", "public_key": public, "bot_token": token}).json()
    assert r["registered"] is True and r["error"] is None and r["has_token"] is True and "bot_token" not in r
    assert r["endpoint"].endswith("/api/discord/interactions") and "client_id=1234567890123456789" in r["invite"]
    url, kw = calls[0]
    assert url.endswith("/applications/1234567890123456789/commands") and kw["headers"]["Authorization"] == f"Bot {token}"
    assert kw["json"][0]["name"] == "demos"
    assert token not in c.get("/api/discord/config").text
    # vérification de l'adresse par Discord : PING signé, et une signature fausse refusée
    assert _signed(c, key, {"type": 1}).json() == {"type": 1}
    assert _signed(c, key, {"type": 1}, bad=True).status_code == 401
    assert _signed(c, key, {"type": 1}, ts=int(time.time()) - 3600).status_code == 401  # rejouée
    assert c.post("/api/discord/interactions", json={"type": 1}).status_code == 401
    # /demos : réponse immédiate, message complété ensuite
    asked, sent = [], []
    monkeypatch.setattr(discord_api, "ask", lambda sf, st, maps, name, n, by: asked.append((name, n, by)) or "📥 ok")

    async def fake_followup(app_id, tok, text):
        sent.append((app_id, tok, text))
    monkeypatch.setattr(discord_api, "followup", fake_followup)
    cmd = {"type": 2, "application_id": "1234567890123456789", "token": "itok",
           "member": {"user": {"username": "paul", "global_name": "Paul"}},
           "data": {"name": "demos", "options": [{"name": "adversaire", "value": "Rivals"}, {"name": "nombre", "value": 3}]}}
    assert _signed(c, key, cmd).json() == {"type": 5}
    for _ in range(50):
        if sent:
            break
        time.sleep(0.05)
    assert asked == [("Rivals", 3, "Paul")] and sent == [("1234567890123456789", "itok", "📥 ok")]


def test_discord_ask_picks_and_queues(client, monkeypatch, tmp_path):  # noqa: F811
    c, _ = client
    soon = int(time.time()) + 3 * 86400
    _faceit_api(monkeypatch, tmp_path, {"/matches/1-a": _match("1-a", "Rivals", soon)})
    monkeypatch.setattr(discord_api, "FaceitClient", integrations_api.FaceitClient)
    monkeypatch.setattr(faceit_demos.scout, "team_overview", lambda cl, tid, *a, **k: FICHE)
    st, sf, maps = c.app.state.settings, c.app.state.session_factory, c.app.state.maps
    with sf() as db:
        db.add(CalendarEvent(source="faceit", external_id="1-a", kind="match", title="ESEA vs. Rivals", opponent="Rivals",
                             starts_at=utcnow() + timedelta(days=3),
                             map_odds=json.dumps({"maps": [{"map": "de_mirage", "pct": 40}], "them": 4, "us": 9, "few": True})))
        db.commit()
    text = discord_api.ask(sf, st, maps, "", 2, "Paul")
    assert text.startswith("📥 **2 démos de Rivals** en file (demandé par Paul) :"), text
    assert "Mirage 13–9" in text.splitlines()[1]  # sa carte probable d'abord
    assert discord_api.ask(sf, st, maps, "rivals", 5, "Paul").startswith("📥 **1 démo de Rivals**")
    assert "Rien de nouveau pour **Rivals**" in discord_api.ask(sf, st, maps, "Rivals", 2, "")
    with sf() as db:
        assert {r.external_id for r in db.query(DemoSource)} == {"1-00000000-0000-4000-8000-000000000001", "1-00000000-0000-4000-8000-000000000002", "1-00000000-0000-4000-8000-000000000003"}
    monkeypatch.setattr(faceit_demos, "disk_free", lambda d: 2 * 1024 ** 3)
    assert "Go libres" in discord_api.ask(sf, st, maps, "Rivals", 2, "")
