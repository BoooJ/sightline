# backend/tests/test_debrief.py
import io

from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def _match(c):
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    return c.get("/api/matches").json()[0]


def test_debrief_and_notes(client):
    c, _ = client
    m = _match(c)
    mid = m["id"]
    assert c.get(f"/api/matches/{mid}/debrief?team=999999").status_code == 400
    d = c.get(f"/api/matches/{mid}/debrief").json()
    assert len(d["teams"]) == 2 and d["catalog"] and d["matches_compared"] == 0
    met = d["metrics"]
    assert met["rounds"]["n"] == met["t_side"]["n"] + met["ct_side"]["n"] > 0
    assert met["pistols"]["n"] <= 2
    # une ouverture par round au plus, gagnée ou perdue
    assert met["after_open_win"]["n"] + met["after_open_loss"]["n"] == met["opening"]["n"] <= met["rounds"]["n"]
    assert met["after_open_win"]["n"] == met["opening"]["k"]
    assert all(p["stat"]["n"] > 0 and p["usual"] is None for p in d["phases"])  # un seul match : pas de référence
    assert len(d["issues"]) <= 3 and all(i["text"] and i["stat"]["n"] >= 2 for i in d["issues"])
    nums = [r["number"] for r in d["review"]]
    assert d["review"] and len(nums) == len(set(nums)) <= 5
    assert all(r["round_id"] and r["why"] for r in d["review"])
    # les deux équipes ont des rounds complémentaires
    other = d["teams"][1]["id"]
    d2 = c.get(f"/api/matches/{mid}/debrief?team={other}").json()
    assert d2["metrics"]["rounds"]["k"] + met["rounds"]["k"] == met["rounds"]["n"]
    assert d2["metrics"]["opening"]["k"] + met["opening"]["k"] == met["opening"]["n"]
    # conclusions écrites, gardées par équipe
    tid = d["teams"][0]["id"]
    assert c.put(f"/api/matches/{mid}/debrief?team={tid}", json={"worked": "Pistols", "change": "Échanges", "actions": "Binômes"}).json()["ok"]
    n = c.get(f"/api/matches/{mid}/debrief?team={tid}").json()["notes"]
    assert (n["worked"], n["change"], n["actions"]) == ("Pistols", "Échanges", "Binômes") and n["updated_at"]
    assert c.get(f"/api/matches/{mid}/debrief?team={other}").json()["notes"]["worked"] == ""


def test_goals_lifecycle(client):
    c, _ = client
    m = _match(c)
    tid = m["team_a"]["id"] if "team_a" in m else c.get(f"/api/matches/{m['id']}/debrief").json()["teams"][0]["id"]
    assert c.post(f"/api/teams/{tid}/goals", json={"metric": "nope"}).status_code == 400
    assert c.post(f"/api/teams/{tid}/goals", json={"metric": "traded", "target": "abc"}).status_code == 400
    g = c.post(f"/api/teams/{tid}/goals", json={"metric": "traded", "title": "Rester à portée d'échange", "target": 60,
                                                  "source_match_id": m["id"], "note": "binômes"}).json()
    assert g["title"] == "Rester à portée d'échange" and g["target"] == 60 and g["better"] == "up"
    # le match d'origine compte « avant » ; aucun match après : en attente
    assert g["status"] == "waiting" and g["before"]["n"] > 0 and g["after"]["n"] == 0
    assert len(g["series"]) == 1 and g["series"][0]["after"] is False
    lst = c.get(f"/api/teams/{tid}/goals").json()
    assert [x["id"] for x in lst] == [g["id"]]
    d = c.get(f"/api/matches/{m['id']}/debrief?team={tid}").json()
    assert d["goals"][0]["id"] == g["id"] and d["goals"][0]["here"]["n"] == g["before"]["n"]
    up = c.patch(f"/api/goals/{g['id']}", json={"archived": True, "target": None}).json()
    assert up["archived"] and up["target"] is None
    assert c.get(f"/api/teams/{tid}/goals").json() == []
    assert len(c.get(f"/api/teams/{tid}/goals?archived=true").json()) == 1
    assert c.delete(f"/api/goals/{g['id']}").json()["ok"]
    assert c.get(f"/api/goals/{g['id']}").status_code in (404, 405)
    assert c.get("/api/goals/metrics").json()[0]["key"] == "rounds"


def test_default_metrics(client):
    """Mesures « Defaults avec prise du site » et « Pressions qui ont fait tourner un CT », tirées du playbook du match."""
    from app.stats.analysis import match_analysis
    from app.stats.debrief import ISSUE_KEYS, METRICS, PHASE_KEYS, team_match_metrics
    from app.stats.playbook import match_t_rounds
    assert METRICS["default_take"]["better"] == "up" and METRICS["default_take"]["ref"] == 0.28
    assert METRICS["ct_rotated"]["better"] == "up" and METRICS["ct_rotated"]["ref"] == 0.63
    assert "default_take" in ISSUE_KEYS and "ct_rotated" not in ISSUE_KEYS
    assert PHASE_KEYS.index("default_take") == PHASE_KEYS.index("armed") + 1
    assert PHASE_KEYS.index("ct_rotated") == PHASE_KEYS.index("default_take") + 1
    assert next(iter(METRICS)) == "rounds" and list(METRICS)[-2:] == ["default_take", "ct_rotated"]
    c, _ = client
    mid = _match(c)["id"]
    teams = {t["name"]: t["id"] for t in c.get("/api/scouting/teams").json()}
    with c.app.state.session_factory() as db:
        a = match_analysis(db, mid)
        for team in teams.values():
            rows = match_t_rounds(db, c.app.state.maps, mid, team)
            out = team_match_metrics(db, mid, team, a, t_rounds=rows)
            dl = [x for x in rows if x["category"] == "default"]
            assert out["default_take"]["n"] == len(dl) and out["default_take"]["k"] == sum(x["engage_s"] is not None for x in dl)
            pr = [x for x in rows if x["category"] != "eco" and x["pressure_s"] is not None and x["rotation_measurable"]]
            assert out["ct_rotated"]["n"] == len(pr) and out["ct_rotated"]["k"] == sum(x["ct_rotation_s"] is not None for x in pr)
            assert out["ct_rotated"]["n"] == 0   # Nuke : sites superposés, rotation non mesurable
            # sur une carte où elle est mesurable, chaque pression hors eco compte (ici, toutes suivies d'une rotation)
            # (une pression ajoutée à chaque round, eco compris : les rounds eco restent hors du compte)
            meas = [{**x, "rotation_measurable": True, "pressure_s": 20.0, "ct_rotation_s": 25.0} for x in rows]
            out2 = team_match_metrics(db, mid, team, a, t_rounds=meas)
            n_pr = sum(x["category"] != "eco" for x in rows)
            assert out2["ct_rotated"]["n"] == out2["ct_rotated"]["k"] == n_pr
            assert set(out) == set(METRICS)
            four = team_match_metrics(db, mid, team, a)   # appel à 4 arguments : rien sur le playbook
            assert four["default_take"]["n"] == four["ct_rotated"]["n"] == 0 and set(four) == set(METRICS)
        dmax = match_t_rounds(db, c.app.state.maps, mid, teams["3DMAX"])
        assert len(dmax) > 0
    assert METRICS["default_take"]["label"] == "Defaults avec prise du site"
    d = c.get(f"/api/matches/{mid}/debrief?team={teams['3DMAX']}").json()
    phases = {p["key"]: p for p in d["phases"]}
    n_default = sum(x["category"] == "default" for x in dmax)
    assert n_default >= 1 and phases["default_take"]["stat"]["n"] == n_default
    # des pressions, mais pas de phase « Pressions qui ont fait tourner un CT » : rotation non mesurable sur Nuke
    assert any(x["category"] != "eco" and x["pressure_s"] is not None for x in dmax)
    assert "ct_rotated" not in phases
    assert c.get("/api/goals/metrics").json()[0]["key"] == "rounds"


def test_review_default_lost_to_duels():
    """Un default perdu sans prise du site prend la place du « Round armé perdu » dans les rounds à revoir."""
    from types import SimpleNamespace as NS

    from app.stats.debrief import METRICS, _review_rounds
    rounds = {n: NS(id=100 + n, ct_team_id=2, t_team_id=1, winner_side="CT" if n in (7, 8) else "T",
                    ct_buy_type="full", t_buy_type="full", end_reason="t_killed") for n in range(1, 16)}

    def cur(default_bad):
        c = {k: {"k": 0, "n": 0, "bad": []} for k in METRICS}
        c["default_take"]["bad"] = default_bad
        c["armed"]["bad"] = [8]
        return c
    out = _review_rounds(None, 1, rounds, cur([7]))
    assert {"number": 7, "kind": "default_duels", "label": "Default perdu aux duels"}.items() <= next(
        r for r in out if r["number"] == 7).items()
    assert not any(r["kind"] == "armed" for r in out) and len(out) <= 5 and any(r["kind"] == "good" for r in out)
    for bad in ([], [9]):   # pas de default sans prise, ou seulement un round gagné : le round armé perdu revient
        out = _review_rounds(None, 1, rounds, cur(bad))
        assert any(r["kind"] == "armed" and r["number"] == 8 for r in out) and not any(r["kind"] == "default_duels" for r in out)
        assert len(out) <= 5 and any(r["kind"] == "good" for r in out)
    # « sans prise » (temps écoulé) : personne n'a joué de duel, ce n'est pas un « Default perdu aux duels »
    rounds[7].end_reason = "time_ran_out"
    out = _review_rounds(None, 1, rounds, cur([7]))
    assert any(r["kind"] == "armed" and r["number"] == 8 for r in out) and not any(r["kind"] == "default_duels" for r in out)


def test_goal_before_after_across_matches(monkeypatch):
    """Les matchs joués après la création de l'axe sont comparés à ceux d'avant ; le match d'origine compte « avant »."""
    from datetime import datetime
    from types import SimpleNamespace as NS

    import app.stats.debrief as dbf
    team, opp = NS(name="Nous"), NS(name="Eux")
    mk = lambda i, day: NS(id=i, played_at=datetime(2026, 1, day), demo=None, map_name="de_nuke", team_a_id=1, team_a=team, team_b=opp)  # noqa: E731
    ms = [mk(1, 1), mk(2, 5), mk(3, 10), mk(4, 12)]
    monkeypatch.setattr(dbf, "team_matches", lambda session, tid: ms)
    vals = {1: (3, 10), 2: (4, 10), 3: (7, 10), 4: (8, 10)}  # morts échangées : 35 % avant, 75 % après
    of = lambda mid: {"traded": {"k": vals[mid][0], "n": vals[mid][1]}}  # noqa: E731
    g = NS(team_id=1, metric="traded", created_at=datetime(2026, 1, 5), source_match_id=2, target=60.0)
    p = dbf.goal_progress(None, g, of)
    assert [s["after"] for s in p["series"]] == [False, False, True, True]  # match d'origine (le 5) : avant
    assert (p["before"]["k"], p["before"]["n"], p["after"]["k"], p["after"]["n"]) == (7, 20, 15, 20)
    assert p["status"] == "better" and p["reached"] is True
    # mesure « le moins possible » : une hausse est un recul
    g2 = NS(team_id=1, metric="avoidable", created_at=datetime(2026, 1, 5), source_match_id=2, target=None)
    p2 = dbf.goal_progress(None, g2, lambda mid: {"avoidable": {"k": vals[mid][0], "n": vals[mid][1]}})
    assert p2["status"] == "worse" and p2["reached"] is None
    # aucun match après : en attente
    g3 = NS(team_id=1, metric="traded", created_at=datetime(2026, 2, 1), source_match_id=None, target=None)
    assert dbf.goal_progress(None, g3, of)["status"] == "waiting"
