# backend/tests/test_context_filters.py
"""Filtres de la barre de contexte commune (équipe, N derniers matchs, officiel / entraînement, derniers mois,
achat adverse), résumé de contexte et référence de comparaison."""
import io

from app.stats.compute import econ_ok
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def _seed(c):
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    m = c.get("/api/matches").json()[0]
    return m


def test_econ_ok_opponent():
    assert econ_ok("buy", "full", "eco", opp_econ="eco")
    assert not econ_ok("buy", "full", "eco", opp_econ="buy")
    assert econ_ok(None, "eco", "force", opp_econ="buy")
    assert not econ_ok(None, "eco", "pistol", opp_econ="eco")


def test_context_filters(client):
    c, _ = client
    m = _seed(c)
    faze = m["team_a"]["id"] if m["team_a"]["name"] == "FaZe" else m["team_b"]["id"]
    assert m["kind"] == "practice"  # ni événement ni dossier « officiels »
    assert len(c.get("/api/matches?kind=practice").json()) == 1
    assert c.get("/api/matches?kind=official").json() == []
    assert c.get("/api/matches?kind=bogus").status_code == 400
    assert len(c.get(f"/api/matches?team={faze}").json()) == 1
    assert c.get("/api/matches?team=999").json() == []
    assert len(c.get("/api/matches?last_n=1").json()) == 1
    assert len(c.get("/api/matches?months=1").json()) == 1  # importée aujourd'hui
    # match daté d'il y a longtemps et marqué officiel
    c.patch(f"/api/matches/{m['id']}/labels", json={"played_on": "2026-01-05", "event": "Major"})
    assert c.get("/api/matches?months=1").json() == []
    assert len(c.get("/api/matches?kind=official").json()) == 1
    assert c.get("/api/matches?kind=practice").json() == []
    ctx = c.get(f"/api/context?team={faze}").json()
    assert ctx["matches"] == 1 and ctx["maps"] == 1 and ctx["rounds"] == 23 and ctx["official"] == 1
    assert ctx["list"][0]["id"] == m["id"]
    assert c.get("/api/context?months=1").json()["matches"] == 0


def test_opp_econ_and_team_scope(client):
    c, _ = client
    m = _seed(c)
    faze = m["team_a"]["id"] if m["team_a"]["name"] == "FaZe" else m["team_b"]["id"]
    everyone = c.get("/api/players").json()
    assert len(everyone) == 10
    own = c.get(f"/api/players?team={faze}").json()
    assert len(own) == 5 and all(p["team"] == "FaZe" for p in own)
    vs_eco = c.get("/api/players?opp_econ=eco").json()
    total, sub = sum(p["rounds"] for p in everyone), sum(p["rounds"] for p in vs_eco)
    assert 0 < sub < total
    assert c.get("/api/players?opp_econ=bogus").status_code == 400
    sid = everyone[0]["steamid"]
    p = c.get(f"/api/players/{sid}?opp_econ=buy").json()
    assert p["rounds"] <= everyone[0]["rounds"] and p["history"]
    # le tableau de bord appelle la fiche en interne : il doit fonctionner sans la dépendance de filtres
    d = c.get(f"/api/players/{sid}/dashboard")
    assert d.status_code == 200 and d.json()["player"]["name"] == everyone[0]["name"]


def test_compare_baselines(client):
    c, _ = client
    m = _seed(c)
    faze = m["team_a"]["id"] if m["team_a"]["name"] == "FaZe" else m["team_b"]["id"]
    own = c.get(f"/api/players?team={faze}").json()
    b = c.get(f"/api/compare?mode=teams&cmp_teams={faze}&cmp_months=12").json()
    assert b["players"] == 5 and b["rounds"] == sum(p["rounds"] for p in own)
    expect = sum(p["rating"] * p["rounds"] for p in own) / b["rounds"]
    assert abs(b["stats"]["rating"] - expect) < 1e-6
    assert set(b["stats"]) >= {"rating", "adr", "kpr", "dpr", "kast", "hs_pct", "opening_pct", "utility_pr", "clutch_pct"}
    empty = c.get("/api/compare?mode=teams").json()
    assert empty["rounds"] == 0 and empty["stats"] == {}
    sid = own[0]["steamid"]
    # un seul match dans la bibliothèque : pas de forme passée
    s = c.get(f"/api/compare?mode=self&steamid={sid}&last_n=1").json()
    assert s["mode"] == "self" and s["rounds"] == 0
    assert c.get("/api/compare?mode=self").status_code == 400
    assert c.get("/api/compare?mode=bogus").status_code == 400


def test_comparison_setting_on_account(client):
    c, _ = client
    c.post("/api/auth/setup", json={"username": "coach", "display_name": "Coach", "password": "Secret-1234"})
    me = c.get("/api/auth/me").json()["user"]
    assert me["comparison"] is None
    r = c.patch("/api/auth/me", json={"comparison": {"mode": "teams", "teams": [1, 2], "months": 6}})
    assert r.status_code == 200 and r.json()["comparison"] == {"mode": "teams", "teams": [1, 2], "months": 6}
    assert c.get("/api/auth/me").json()["user"]["comparison"]["months"] == 6
    assert c.patch("/api/auth/me", json={"comparison": {"mode": "x"}}).status_code == 400
    assert c.patch("/api/auth/me", json={"comparison": {"mode": "teams", "teams": [1, 2, 3, 4, 5, 6]}}).status_code == 400
    assert c.patch("/api/auth/me", json={"comparison": None}).json()["comparison"] is None
