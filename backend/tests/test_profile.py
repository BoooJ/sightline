# backend/tests/test_profile.py
"""Fiche joueur à onglets : stats regroupées par poste, arme, achat, carte, type de match ; progression."""
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_profile_endpoint(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    rows = c.get("/api/players").json()
    sid = rows[0]["steamid"]
    pr = c.get(f"/api/players/{sid}/profile").json()
    assert set(pr) == {"intro", "roles", "weapons", "weapon_classes", "buytypes", "maps", "kinds", "recent", "progression"}
    assert pr["intro"]["matches"] == 1 and pr["intro"]["rounds"] == 23 and pr["intro"]["team"] == rows[0]["team"]
    # les types d'achat couvrent tous les rounds du joueur ; les cartes aussi
    assert sum(b["rounds"] for b in pr["buytypes"]["matrix"]) == rows[0]["rounds"]
    assert [m["map"] for m in pr["maps"]] == ["de_nuke"] and pr["maps"][0]["matches"] == 1
    assert set(pr["maps"][0]["sides"]) <= {"CT", "T"}
    assert pr["kinds"]["practice"]["matches"] == 1
    assert len(pr["recent"]) == 1 and pr["recent"][0]["opponent"] in ("FaZe", "3DMAX") and set(pr["recent"][0]["poste"]) == {"t", "ct"}
    assert pr["progression"]["recent"]["matches"] == 1 and pr["progression"]["previous"] is None
    # armes : classes connues seulement, parts qui se somment à 100 % des rounds où une arme est connue
    assert all(w["class"] in (None, "rifle", "sniper", "smg", "heavy", "pistol", "default_pistol") for w in pr["weapons"])
    # filtres de la barre de contexte
    assert c.get(f"/api/players/{sid}/profile?side=CT").json()["intro"]["rounds"] == 23  # rounds du joueur (les deux camps) ; stats CT
    assert c.get(f"/api/players/{sid}/profile?map=de_dust2").status_code == 404
    assert c.get(f"/api/players/{sid}/profile?opp_econ=bogus").status_code == 400
