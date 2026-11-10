"""Insère la fixture Nuke dans la base (démo sans vrai fichier). Usage : python scripts/seed_fixture.py"""
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from app.core.config import ROOT, Settings, load_settings  # noqa: E402
from app.core.db import init_db, make_engine, make_session_factory  # noqa: E402
from app.maps.registry import load_maps  # noqa: E402
from app.parsing.build import build_demo  # noqa: E402
from app.parsing.extract import load_raw  # noqa: E402
from app.storage.models import Demo  # noqa: E402
from app.storage.repository import save_parsed_demo  # noqa: E402

s = Settings(data_dir=Path(os.environ["SKYBOX_DATA_DIR"])) if os.environ.get("SKYBOX_DATA_DIR") else load_settings()
init_db(s.db_url)
sf = make_session_factory(make_engine(s.db_url))
with sf() as db:
    if db.query(Demo).filter_by(sha256="f" * 64).first() is None:
        d = Demo(path="fixture://nuke_sample", file_name="fixture-nuke.dem", size=0, sha256="f" * 64, status="ready", progress=100)
        db.add(d)
        db.flush()
        save_parsed_demo(db, d.id, build_demo(load_raw(BACKEND / "tests" / "fixtures" / "nuke_sample")), load_maps(ROOT / "maps"))
        db.commit()
print("fixture insérée dans", s.db_url)
