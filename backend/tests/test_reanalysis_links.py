# backend/tests/test_reanalysis_links.py
"""Une ré-analyse (bouton « Ré-analyser », ou nouveau PARSER_VERSION au démarrage) garde la ligne du match : les
données de l'équipe qui la visent par clé étrangère (liens de partage, débriefs, notes, vetos, objectifs, comms)
restent présentes et rattachées. Les rounds, eux, sont reconstruits : les rounds superposés d'un lien de partage
(ids de rounds) suivent par numéro de round."""
import io
from datetime import datetime

from app.storage.models import CommsSession, Match, MatchDebrief, Note, Round, ShareLink, TeamGoal, VetoRecord
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def _upload(c, name: str, content: bytes) -> None:
    r = c.post("/api/demos/upload", files=[("files", (name, io.BytesIO(content), "application/octet-stream"))])
    assert r.status_code == 200 and r.json()[0]["created"]
    wait_ready(c)


def test_reanalysis_keeps_linked_team_data(client):
    c, _ = client
    _upload(c, "a.dem", b"a" * 10)
    _upload(c, "b.dem", b"b" * 10)  # rounds créés après ceux du premier match : les ids de la ré-analyse changeront
    demo = next(d for d in c.get("/api/demos").json() if d["file_name"] == "a.dem")
    mid = demo["match_id"]
    detail = c.get(f"/api/matches/{mid}").json()
    by_number = {r["number"]: r["id"] for r in detail["rounds"]}
    link = c.post("/api/share", json={"match_id": mid, "round_number": 2, "layers": [by_number[3], by_number[5]]}).json()
    assert link["layers"] == [by_number[3], by_number[5]]

    sf = c.app.state.session_factory
    with sf() as db:
        m = db.get(Match, mid)
        team_a, team_b = m.team_a_id, m.team_b_id
        db.add(MatchDebrief(match_id=mid, team_id=team_a, worked="les retakes B", change="le mid", actions="rejouer"))
        note = Note(map_name="de_nuke", body="smoke de la porte", match_id=mid)
        veto = VetoRecord(team_a_id=team_a, team_b_id=team_b, format="bo1", match_id=mid)
        goal = TeamGoal(team_id=team_a, metric="rounds", title="gagner plus de rounds", source_match_id=mid)
        comms = CommsSession(status="attached", map_name="de_nuke", started_at=datetime(2026, 10, 20, 20, 0),
                             payload="{}", folder="x", match_id=mid, offset_s=1.5)
        db.add_all([note, veto, goal, comms])
        db.commit()
        ids = {"note": note.id, "veto": veto.id, "goal": goal.id, "comms": comms.id}

    assert c.post(f"/api/demos/{demo['id']}/reparse").json()["ok"]
    wait_ready(c)

    after = next(d for d in c.get("/api/demos").json() if d["id"] == demo["id"])
    assert after["status"] == "ready" and after["match_id"] == mid
    new_detail = c.get(f"/api/matches/{mid}").json()
    new_by_number = {r["number"]: r["id"] for r in new_detail["rounds"]}
    assert len(new_by_number) == 23
    assert new_by_number[3] != by_number[3]  # précondition : la ré-analyse a bien recréé les rounds sous d'autres ids

    with sf() as db:
        assert db.get(Match, mid) is not None
        sl = db.query(ShareLink).one()
        assert sl.token == link["token"] and sl.match_id == mid and sl.round_number == 2
        d = db.get(MatchDebrief, (mid, team_a))
        assert d is not None and (d.worked, d.change, d.actions) == ("les retakes B", "le mid", "rejouer")
        assert db.get(Note, ids["note"]).match_id == mid
        assert db.get(VetoRecord, ids["veto"]).match_id == mid
        assert db.get(TeamGoal, ids["goal"]).source_match_id == mid
        cs = db.get(CommsSession, ids["comms"])
        assert cs.match_id == mid and cs.status == "attached" and cs.offset_s == 1.5
        assert db.query(Round).filter(Round.match_id == mid).count() == 23

    # le lien public marche toujours, et ses rounds superposés visent les nouveaux rounds de mêmes numéros
    shared = c.get(f"/api/share/{link['token']}")
    assert shared.status_code == 200
    body = shared.json()
    assert body["match"]["id"] == mid and body["layers"] == [new_by_number[3], new_by_number[5]]
    for rid in body["layers"]:
        assert c.get(f"/api/share/{link['token']}/replay/{rid}").status_code == 200
    # le débrief se relit par l'API
    assert c.get(f"/api/matches/{mid}/debrief?team={team_a}").json()["notes"]["worked"] == "les retakes B"
