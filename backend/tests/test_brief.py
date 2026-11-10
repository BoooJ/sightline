# backend/tests/test_brief.py
import io

from app.stats.brief import stat, wilson
from app.stats.playbook import DEFAULT_KIND_LABELS, DEFAULT_KINDS, engage_summary
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_stat_reliability_and_tone():
    assert stat(2, 3)["level"] == "anecdotal" and stat(2, 3)["tone"] == "neutral"
    assert stat(7, 9)["level"] == "indicative"
    s = stat(18, 20)
    assert s["level"] == "solid" and s["tone"] == "good" and s["pct"] == 90
    assert stat(1, 20)["tone"] == "bad"
    assert stat(1, 20, judge=False)["tone"] == "neutral"  # une fréquence n'est ni bonne ni mauvaise
    assert stat(0, 0)["level"] == "none" and stat(0, 0)["pct"] is None
    lo, hi = wilson(7, 9)
    assert 0.49 < lo < 0.52 and 0.91 < hi < 0.93  # 7/9 : de 50 à 92 % (90 %)


def test_brief_endpoint(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    team = c.get("/api/scouting/teams").json()[0]
    assert c.get(f"/api/scouting/teams/{team['id']}/brief?map=de_inconnue").status_code == 404
    b = c.get(f"/api/scouting/teams/{team['id']}/brief?map=de_nuke").json()
    assert b["matches"] == 1 and b["display_name"]
    assert b["sides"]["T"]["n"] + b["sides"]["CT"]["n"] > 0
    for side in ("T", "CT"):
        p = b["pistols"][side]
        assert p["result"]["n"] <= 2 and p["result"]["level"] == "anecdotal"
    assert b["players"] and all(set(pl["spots"]) == {"T", "CT"} for pl in b["players"])
    assert any(pl["spots"]["T"] or pl["spots"]["CT"] for pl in b["players"])  # postes à 20 s trouvés
    spot = next(s for pl in b["players"] for side in ("T", "CT") for s in pl["spots"][side])
    assert len(spot["pos"]) == 3  # position moyenne réelle du joueur à ce poste, pour le radar
    assert all(u["place"] for side in ("T", "CT") for u in b["utility"][side])
    assert all(len(u["pos"]) == 3 for side in ("T", "CT") for u in b["utility"][side])
    assert b["takeaways"] and all(t["text"] and "stat" in t for t in b["takeaways"])
    # pistol T perdu : séparé selon la pose de la bombe (+800 $ par joueur : force possible)
    pt = b["pistols"]["T"]
    parts = [pt.get(k) for k in ("after_lost_planted", "after_lost_unplanted")]
    assert sum(x["won"]["n"] for x in parts if x) == (pt["after_lost"]["won"]["n"] if pt["after_lost"] else 0)
    assert "after_lost_planted" not in b["pistols"]["CT"]  # le bonus de pose ne concerne que les T
    # anti-strat : implication en ouverture, conversion de l'équipe, rounds à revoir, référence bibliothèque
    for pl in b["players"]:
        att = pl["opening_attempts"]
        assert att["n"] == b["sides"]["T"]["n"] + b["sides"]["CT"]["n"] and att["k"] == pl["opening"]["n"]
        assert pl["after_open_win"]["n"] == pl["opening"]["k"]
    rid = {int(k) for k in b["round_index"]}
    assert b["review"] and all(g["label"] and g["why"] and g["rounds"] for g in b["review"])
    assert all(set(g["rounds"]) <= rid for g in b["review"])
    assert b["review"][0]["key"] == "pistols_T"
    # un seul camp par groupe : on superpose des rounds comparables
    assert all(g["side"] in ("T", "CT") for g in b["review"])
    assert not ({r for g in b["review"] if g["side"] == "T" for r in g["rounds"]} & {r for g in b["review"] if g["side"] == "CT" for r in g["rounds"]})
    # « default puis exécution » : compté parmi les rounds default
    dflt = next((x for x in b["t_styles"] if x["key"] == "default"), None)
    if dflt:
        assert dflt["late_exec"]["n"] == dflt["count"]["k"] and dflt["late_exec"]["k"] <= dflt["late_exec"]["n"]
    # sous-types du default, prise des sites et rotation CT, pour les deux équipes, avec et sans « armés seulement »
    for tm in c.get("/api/scouting/teams").json():
        t_list = c.get(f"/api/scouting/teams/{tm['id']}/playbook?map=de_nuke").json()["t"]["list"]
        for q in ("", "&armed=true"):
            bb = c.get(f"/api/scouting/teams/{tm['id']}/brief?map=de_nuke{q}").json()
            d = next((x for x in bb["t_styles"] if x["key"] == "default"), None)
            if d:
                assert sum(k["count"]["k"] for k in d["kinds"]) == d["count"]["k"]
                assert d["late_exec"]["k"] == next((k["count"]["k"] for k in d["kinds"] if k["key"] == "exec"), 0)
                assert [k["key"] for k in d["kinds"]] == [k for k in DEFAULT_KINDS if k in {x["key"] for x in d["kinds"]}]
                assert all(k["label"] == DEFAULT_KIND_LABELS[k["key"]] and k["won"]["n"] == k["count"]["k"] for k in d["kinds"])
            assert bb["engage_by_site"] == engage_summary([x for x in t_list if str(x["round_id"]) in bb["round_index"]])
            assert all(x["rotation_measurable"] is False for x in t_list)
            assert bb["ct_rotation"] is None   # Nuke : sites A et B superposés, rotation CT non mesurable
    assert b["library_teams"] == 0 and all(s["lib_pct"] is None for s in b["t_styles"])  # une seule démo : pas de référence
    assert c.get(f"/api/scouting/teams/{team['id']}").json()["faceit_team_id"] is None
