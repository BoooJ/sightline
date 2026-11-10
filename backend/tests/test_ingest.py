# backend/tests/test_ingest.py
import asyncio
import bz2
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.core.config import Settings
from app.core.db import init_db, make_engine, make_session_factory
from app.ingest.bus import ProgressBus
from app.ingest.files import prepare_demo_file, sha256_file
from app.ingest.service import ImportService
from app.parsing.build import build_demo
from app.parsing.extract import load_raw
from app.storage.models import Demo, Match, Notification

FIX = Path(__file__).parent / "fixtures" / "nuke_sample"


def fixture_parse(path, sample_rate, build_opts, progress):
    if Path(path).read_bytes().startswith(b"BAD"):
        raise ValueError("fichier corrompu")
    progress(50, "fixture")
    return build_demo(load_raw(FIX))


@pytest.fixture
def env(tmp_path):
    s = Settings(data_dir=tmp_path / "data", demo_folders=[tmp_path / "demos"])
    init_db(s.db_url)
    sf = make_session_factory(make_engine(s.db_url))
    (tmp_path / "demos" / "sub").mkdir(parents=True)
    return s, sf, tmp_path


def make_service(s, sf):
    return ImportService(s, sf, ProgressBus(), parse_fn=fixture_parse,
                         executor_factory=lambda n: ThreadPoolExecutor(n))


def test_files(tmp_path):
    p = tmp_path / "a.dem"
    p.write_bytes(b"hello")
    assert sha256_file(p) == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    z = tmp_path / "b.dem.bz2"
    z.write_bytes(bz2.compress(b"demo"))
    out = prepare_demo_file(z, tmp_path / "cache")
    assert out.suffix == ".dem" and out.read_bytes() == b"demo"


def test_import_scan_dedupe_error(env):
    s, sf, tmp = env
    (tmp / "demos" / "m1.dem").write_bytes(b"GOOD1")
    (tmp / "demos" / "sub" / "m2.dem").write_bytes(b"GOOD1")  # même contenu -> doublon
    (tmp / "demos" / "bad.dem").write_bytes(b"BAD!")
    (tmp / "demos" / "notes.txt").write_text("x")

    async def run():
        svc = make_service(s, sf)
        q = svc.bus.subscribe()
        await svc.start()
        res = await svc.scan_folders()
        await svc.wait_idle()
        await svc.stop()
        events = []
        while not q.empty():
            events.append(q.get_nowait())
        return res, events

    res, events = asyncio.run(run())
    assert len(res) == 3 and sum(r["created"] for r in res) == 2
    with sf() as db:
        demos = {d.file_name: d for d in db.query(Demo)}
        assert demos["m1.dem"].status == "ready" and demos["m1.dem"].progress == 100
        assert demos["bad.dem"].status == "error" and "corrompu" in demos["bad.dem"].error_message
        assert db.query(Match).count() == 1
    assert any(e["status"] == "ready" and e["match_id"] for e in events)
    assert any(e["status"] == "parsing" for e in events)


def test_reparse(env):
    s, sf, tmp = env
    (tmp / "demos" / "m1.dem").write_bytes(b"GOOD1")

    async def run():
        svc = make_service(s, sf)
        await svc.start()
        await svc.scan_folders()
        await svc.wait_idle()
        with sf() as db:
            demo_id = db.query(Demo).one().id
        await svc.reparse(demo_id)
        await svc.wait_idle()
        await svc.stop()

    asyncio.run(run())
    with sf() as db:
        assert db.query(Match).count() == 1 and db.query(Demo).one().status == "ready"


def test_reanalysis_does_not_announce_match_ready_again(env):
    # Première analyse : une seule alerte « match prêt ». Ré-analyse (nouveau parseur) : aucune nouvelle alerte,
    # mais l'effet de bord de l'import (préchauffage, comms en attente) continue de tourner.
    s, sf, tmp = env
    (tmp / "demos" / "m1.dem").write_bytes(b"GOOD1")
    imported = []

    def ready_count():
        with sf() as db:
            return db.query(Notification).filter(Notification.kind == "match_ready").count()

    async def run():
        svc = make_service(s, sf)
        svc.after_import = imported.append
        await svc.start()
        await svc.scan_folders()
        await svc.wait_idle()
        first = ready_count()
        with sf() as db:
            demo_id = db.query(Demo).one().id
        await svc.reparse(demo_id)
        await svc.wait_idle()
        await svc.stop()
        return first

    first = asyncio.run(run())
    assert first == 1
    assert ready_count() == 1
    assert len(imported) == 2 and imported[0] == imported[1]


def test_default_executor_frees_worker_memory():
    # Le parsing d'une démo laisse ~1 Go dans le processus : chaque worker doit s'arrêter après une démo.
    from app.ingest.service import default_executor

    ex = default_executor(1)
    try:
        assert ex._max_tasks_per_child == 1
    finally:
        ex.shutdown()


def test_broken_pool_is_recreated(env):
    # Un worker tué (ex. manque de mémoire) casse le pool : la démo passe en erreur et les imports suivants marchent.
    from concurrent.futures.process import BrokenProcessPool

    s, sf, tmp = env
    made = []

    class BreaksOnce(ThreadPoolExecutor):
        def submit(self, *a, **kw):
            if len(made) == 1:
                raise BrokenProcessPool("worker tué")
            return super().submit(*a, **kw)

    def factory(n):
        made.append(n)
        return BreaksOnce(n)

    (tmp / "demos" / "m1.dem").write_bytes(b"GOOD1")
    (tmp / "demos" / "m2.dem").write_bytes(b"GOOD2")

    async def run():
        svc = ImportService(s, sf, ProgressBus(), parse_fn=fixture_parse, executor_factory=factory)
        await svc.start()
        await svc.scan_folders()
        await svc.wait_idle()
        await svc.stop()

    asyncio.run(run())
    with sf() as db:
        demos = {d.file_name: d for d in db.query(Demo)}
    assert demos["m1.dem"].status == "error" and "mémoire" in demos["m1.dem"].error_message
    assert demos["m2.dem"].status == "ready"
    assert len(made) == 2
