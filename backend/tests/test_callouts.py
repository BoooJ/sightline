# backend/tests/test_callouts.py
"""Callouts des joueurs en zones : nom d'une position, niveaux de Nuke, zone la plus précise, repli sur le lieu du jeu."""
from app.core.config import ROOT
from app.maps import callouts
from app.maps.registry import load_maps
from app.stats.learn import CUSTOM_R, _place_of
from tests.test_api import client  # noqa: F401  (fixture)

MAPS = load_maps(ROOT / "maps")


def test_every_zone_file_is_valid():
    files = sorted((ROOT / "maps" / "callouts").glob("*.json"))
    assert {f.stem for f in files} >= {"de_mirage", "de_dust2", "de_inferno", "de_nuke", "de_ancient", "de_anubis"}
    for f in files:
        zs = callouts.zones(f.stem)
        assert len(zs) >= 30 and all(z.area > 0 for z in zs), f.stem
        assert [z.area for z in zs] == sorted(z.area for z in zs)


def test_callout_at_zone_centroids():
    """Chaque zone se reconnaît en son propre centre (sauf si une zone plus petite y est imbriquée)."""
    for m in ("de_mirage", "de_inferno", "de_dust2"):
        meta = MAPS[m]
        hits = 0
        zs = callouts.zones(m)
        for z in zs:
            cx = sum(x for x, _ in z.poly) / len(z.poly)
            cy = sum(y for _, y in z.poly) / len(z.poly)
            name = callouts.callout_at(meta, cx, cy, 0)
            hits += name is not None
        assert hits >= 0.8 * len(zs), m


def test_nuke_levels_and_unknown_maps():
    meta = MAPS["de_nuke"]
    upper = next(z for z in callouts.zones("de_nuke") if z.level == "upper")
    cx = sum(x for x, _ in upper.poly) / len(upper.poly)
    cy = sum(y for _, y in upper.poly) / len(upper.poly)
    assert callouts.callout_at(meta, cx, cy, -400) is not None          # niveau haut
    lower_hit = callouts.callout_at(meta, cx, cy, -700)                  # même x/y, niveau bas : pas la zone du haut
    assert lower_hit != upper.name or upper.level is None
    assert callouts.callout_at(MAPS["cs_office"], 0, 0, 0) is None       # carte sans données


def test_place_of_priority():
    meta = MAPS["de_mirage"]
    z = next(z for z in callouts.zones("de_mirage") if z.name.lower() == "window")
    cx = sum(x for x, _ in z.poly) / len(z.poly)
    cy = sum(y for _, y in z.poly) / len(z.poly)
    game = [("SnipersNest", (cx, cy, 0.0), 400.0)]
    assert _place_of(meta, game, cx, cy, 0) == "Window"                  # nom des joueurs plutôt que celui du jeu
    custom = [("Fenêtre de Paul", (cx, cy, 0.0), CUSTOM_R)] + game
    assert _place_of(meta, custom, cx, cy, 0) == "Fenêtre de Paul"        # le callout de l'équipe l'emporte
    assert _place_of(meta, game, 99999, 99999, 0) is None                 # nulle part


def test_callouts_api(client):
    c, _ = client
    z = c.get("/api/maps/de_mirage/callouts").json()
    assert len(z) >= 30 and all(len(x["poly"]) >= 3 and x["name"] for x in z)
    assert c.get("/api/maps/de_office_inconnue/callouts").status_code == 404
    assert c.get("/api/maps/cs_office/callouts").json() == []


def test_team_zones_edit_and_reset(client):
    """Zones dessinées par l'équipe (page Callouts) : elles remplacent celles de Sightline pour nommer les positions,
    partout ; « Réinitialiser » revient aux zones d'origine."""
    from app.stats.cache import LibraryCache
    c, _ = client
    meta = MAPS["de_mirage"]
    base = c.get("/api/maps/de_mirage/zones").json()
    assert base["edited"] is False and len(base["zones"]) >= 30
    window = next(z for z in base["zones"] if z["name"] == "Window")
    cx = sum(x for x, _ in window["poly"]) / len(window["poly"])
    cy = sum(y for _, y in window["poly"]) / len(window["poly"])
    assert callouts.callout_at(meta, cx, cy, 0) == "Window"
    gen = LibraryCache.generation
    zones = [{**z, "name": "Fenêtre", "color": "#ffd23f"} if z["name"] == "Window" else z for z in base["zones"]]
    zones.append({"name": "Coin ninja", "level": None, "poly": [[-2000, -2000], [-1900, -2000], [-1900, -1900]], "color": None})
    r = c.put("/api/maps/de_mirage/zones", json={"zones": zones})
    assert r.status_code == 200 and r.json()["edited"] is True
    assert LibraryCache.generation > gen  # analyses à recalculer avec les nouveaux noms
    assert callouts.callout_at(meta, cx, cy, 0) == "Fenêtre"
    assert callouts.callout_at(meta, -1950, -1980, 0) == "Coin ninja"
    got = c.get("/api/maps/de_mirage/zones").json()
    assert got["edited"] is True and any(z["name"] == "Fenêtre" and z["color"] == "#ffd23f" for z in got["zones"])
    assert any(z["name"] == "Coin ninja" for z in c.get("/api/maps/de_mirage/callouts").json())  # radar de l'histoire
    # validation : polygone trop court, nom vide, couleur, niveau inconnu, carte inconnue
    bad = [{"name": "X", "level": None, "poly": [[0, 0], [1, 1]]}]
    assert c.put("/api/maps/de_mirage/zones", json={"zones": bad}).status_code == 400
    assert c.put("/api/maps/de_mirage/zones", json={"zones": [{**zones[0], "name": " "}]}).status_code == 400
    assert c.put("/api/maps/de_mirage/zones", json={"zones": [{**zones[0], "color": "red"}]}).status_code == 400
    assert c.put("/api/maps/de_mirage/zones", json={"zones": [{**zones[0], "level": "upper"}]}).status_code == 400
    assert c.put("/api/maps/de_inconnue/zones", json={"zones": zones}).status_code == 404
    # réinitialiser : retour aux zones de Sightline
    assert c.delete("/api/maps/de_mirage/zones").json()["edited"] is False
    assert callouts.callout_at(meta, cx, cy, 0) == "Window"
