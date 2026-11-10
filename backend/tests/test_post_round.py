# backend/tests/test_post_round.py
"""Les morts enregistrées après la fin d'un round (bombe qui explose sur des T déjà vainqueurs, joueurs retirés par
le serveur en fin de match) ne comptent ni dans la probabilité de victoire, ni dans les raisons de mort."""
import io

from app.stats.analysis import match_analysis
from app.storage.models import Kill, Round
from tests.test_api import client, wait_ready  # noqa: F401  (fixture)


def test_post_round_deaths_ignored(client):
    c, _ = client
    c.post("/api/demos/upload", files=[("files", ("nuke.dem", io.BytesIO(b"x" * 10), "application/octet-stream"))])
    wait_ready(c)
    mid = c.get("/api/matches").json()[0]["id"]
    with c.app.state.session_factory() as db:
        before = match_analysis(db, mid)
        r = db.query(Round).filter(Round.match_id == mid).order_by(Round.number).first()
        victim = db.query(Kill).filter(Kill.round_id == r.id).first().attacker or db.query(Kill).filter(Kill.round_id == r.id).first().victim
        db.add(Kill(round_id=r.id, tick=r.end_tick + 500, attacker=victim, victim=victim, weapon="world", headshot=False, penetrated=0,
                    through_smoke=False, noscope=False, attacker_blind=False, victim_x=0.0, victim_y=0.0, victim_z=0.0))
        db.commit()
        after = match_analysis(db, mid)
    assert len(after["deaths"]) == len(before["deaths"])
    assert [e["tick"] for e in after["key_moments"]] == [e["tick"] for e in before["key_moments"]]
    ev = next(x for x in after["rounds"] if x["number"] == r.number)["events"]
    assert all(e["tick"] <= r.end_tick for e in ev if e["type"] == "kill")
