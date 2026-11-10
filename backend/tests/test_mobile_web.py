# backend/tests/test_mobile_web.py
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from app.core.config import ROOT, Settings
from app.main import create_app
from tests.test_api import fixture_parse


def _app(tmp_path):
    mob = tmp_path / "mdist"
    (mob / "_expo" / "static" / "js").mkdir(parents=True)
    (mob / "index.html").write_text("<html>app</html>", encoding="utf-8")
    (mob / "sw.js").write_text("self.x=1", encoding="utf-8")
    (mob / "_expo" / "static" / "js" / "entry-abc.js").write_text("console.log(1)", encoding="utf-8")
    s = Settings(data_dir=tmp_path / "data", maps_dir=ROOT / "maps", frontend_dist=tmp_path / "nodist",
                 mobile_dist=mob)
    s._config_path = tmp_path / "config.toml"
    return create_app(s, parse_fn=fixture_parse, executor_factory=lambda n: ThreadPoolExecutor(n))


def test_mobile_web_is_served_under_app(tmp_path):
    with TestClient(_app(tmp_path), client=("127.0.0.1", 50000)) as c:
        r = c.get("/app", follow_redirects=False)
        assert r.status_code == 308 and r.headers["location"] == "/app/"
        assert c.get("/app/").text == "<html>app</html>"
        deep = c.get("/app/matches/12")  # route de l'app : c'est elle qui lit l'adresse
        assert deep.text == "<html>app</html>" and deep.headers["cache-control"] == "no-cache"
        js = c.get("/app/_expo/static/js/entry-abc.js")
        assert js.text == "console.log(1)" and "immutable" in js.headers["cache-control"]
        assert c.get("/app/sw.js").headers["cache-control"] == "no-cache"
        assert c.get("/app/..%2f..%2fconfig.toml").text == "<html>app</html>"  # jamais hors du dossier
        assert c.get("/api/health").json()["ok"]
