"""Test d'intégration sur une vraie démo complète (ignoré si SKYBOX_TEST_DEMO n'est pas défini).

Exemple : SKYBOX_TEST_DEMO=../3dmax-vs-faze-m1-nuke.dem pytest -m realdemo
Attendus (3DMAX vs FaZe, Nuke) : 23 rounds, 3DMAX 13 - 10 FaZe, 151 kills.
"""
import os
import time

import pytest

from app.parsing.build import build_demo
from app.parsing.extract import extract_raw

DEMO = os.environ.get("SKYBOX_TEST_DEMO")
pytestmark = [pytest.mark.realdemo, pytest.mark.skipif(not DEMO, reason="SKYBOX_TEST_DEMO non défini")]


def test_full_demo_pipeline():
    t = time.time()
    demo = build_demo(extract_raw(DEMO, sample_rate=16))
    elapsed = time.time() - t
    print(f"\nparse+build: {elapsed:.1f}s, rounds={len(demo.rounds)}, kills={len(demo.kills)}, "
          f"grenades={len(demo.grenades)}, frames={len(demo.frames)}")
    assert len(demo.frames) == len(demo.rounds)
    assert elapsed < 90
    if "3dmax-vs-faze-m1-nuke" in DEMO:
        assert len(demo.rounds) == 23 and len(demo.kills) == 151
        assert sorted(demo.score.values()) == [10, 13]
        # ~445 grenades lancées hors warmup (smoke 138, flash 101, HE 90, molotov/inc 116, decoy)
        assert 400 <= len(demo.grenades) <= 460
