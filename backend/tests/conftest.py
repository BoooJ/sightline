# backend/tests/conftest.py
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from app.core.config import ROOT
from app.core.db import init_db, make_engine, make_session_factory
from app.maps.registry import load_maps
from app.parsing.build import build_demo
from app.parsing.extract import load_raw

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def nuke_parsed():
    return build_demo(load_raw(FIX / "nuke_sample"))


@pytest.fixture(scope="session")
def nuke_parsed_32(nuke_parsed):
    """La même démo « à 32 i/s » : chaque image du replay à 16 i/s répétée deux fois (même tick), sample_rate 32. Une
    statistique juste d'une bibliothèque qui mélange 16 et 32 i/s donne pour elle exactement les valeurs de l'original."""
    frames = {rn: replace(fr, ticks=np.repeat(fr.ticks, 2), fields={k: np.repeat(v, 2, axis=0) for k, v in fr.fields.items()},
                          inventory=[row for row in fr.inventory for _ in range(2)])
              for rn, fr in nuke_parsed.frames.items()}
    assert nuke_parsed.sample_rate == 16
    return replace(nuke_parsed, sample_rate=32, frames=frames)


@pytest.fixture(scope="session")
def maps():
    return load_maps(ROOT / "maps")


@pytest.fixture
def db_url(tmp_path):
    url = f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    init_db(url)
    return url


@pytest.fixture
def db(db_url):
    engine = make_engine(db_url)
    session = make_session_factory(engine)()
    yield session
    session.close()
    engine.dispose()
