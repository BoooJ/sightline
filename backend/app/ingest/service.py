# backend/app/ingest/service.py
from __future__ import annotations

import asyncio
import logging
import multiprocessing
import threading
from concurrent.futures import Executor, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.notify import notify
from app.ingest.bus import ProgressBus
from app.ingest.files import is_demo_file, prepare_demo_file, sha256_file
from app.integrations import sources, webhooks
from app.integrations.ours import our_team_id
from app.maps.registry import load_maps
from app.parsing.extract import PARSER_VERSION
from app.parsing.model import ParsedDemo
from app.storage.labels import match_kind
from app.storage.models import Demo, Match
from app.storage.repository import save_parsed_demo

log = logging.getLogger(__name__)

ParseFn = Callable[[str, int, dict, Callable[[int, str], None]], ParsedDemo]
PostImportHook = Callable[[Session, int], None]  # (session, match_id)


def default_parse(path: str, sample_rate: int, build_opts: dict, progress: Callable[[int, str], None]) -> ParsedDemo:
    from app.parsing.build import BuildOptions, build_demo
    from app.parsing.extract import extract_raw

    raw = extract_raw(path, sample_rate=sample_rate, progress=progress)
    progress(92, "normalisation")
    return build_demo(raw, BuildOptions(**build_opts))


def default_executor(n: int) -> ProcessPoolExecutor:
    """Pool de parsing. Un worker garde ~1 Go après une démo (mémoire non rendue par pandas/numpy) :
    chaque worker s'arrête après une démo pour la libérer (« spawn » requis par max_tasks_per_child)."""
    return ProcessPoolExecutor(max_workers=n, mp_context=multiprocessing.get_context("spawn"), max_tasks_per_child=1)


def _run_in_worker(parse_fn: ParseFn, path: str, sample_rate: int, build_opts: dict, demo_id: int, queue):
    def progress(pct: int, step: str) -> None:
        if queue is not None:
            queue.put((demo_id, pct, step))
    return parse_fn(path, sample_rate, build_opts, progress)


class ImportService:
    def __init__(self, settings: Settings, session_factory: sessionmaker[Session], bus: ProgressBus,
                 parse_fn: ParseFn = default_parse, executor_factory: Callable[[int], Executor] | None = None,
                 post_import_hooks: list[PostImportHook] | None = None) -> None:
        self.settings = settings
        self.sf = session_factory
        self.bus = bus
        self.parse_fn = parse_fn
        self.executor_factory = executor_factory or default_executor
        self.hooks = post_import_hooks or []
        self.maps = load_maps(settings.maps_dir)
        self._queue: asyncio.Queue[int] = asyncio.Queue()
        self._workers: list[asyncio.Task] = []
        self._executor: Executor | None = None
        self._manager = None
        self._mp_queue = None
        self._relay: threading.Thread | None = None
        self._stop_relay = threading.Event()
        self._busy = 0
        self.after_import: Callable[[int], None] | None = None  # appelé avec l'id du match après chaque import réussi

    # ---------------------------------------------------------------- cycle de vie
    async def start(self) -> None:
        self.bus.bind_loop(asyncio.get_running_loop())
        n = max(1, self.settings.max_parallel_imports)
        self._executor = self.executor_factory(n)
        if isinstance(self._executor, ProcessPoolExecutor):
            self._manager = multiprocessing.Manager()
            self._mp_queue = self._manager.Queue()
            self._relay = threading.Thread(target=self._relay_progress, daemon=True)
            self._relay.start()
        self._workers = [asyncio.create_task(self._worker()) for _ in range(n)]
        with self.sf() as db:
            pending = db.scalars(select(Demo.id).where(Demo.status.in_(["pending", "parsing"]))).all()
        for demo_id in pending:
            await self.enqueue(demo_id)
        # démos analysées par une version plus ancienne du parseur : ré-analyse en arrière-plan (nouvelles données)
        with self.sf() as db:
            outdated = [d.id for d in db.scalars(select(Demo).where(Demo.status == "ready"))
                        if d.parser_version != PARSER_VERSION and Path(d.path).is_file()]
        for demo_id in outdated:
            await self._queue.put(demo_id)

    async def stop(self) -> None:
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._stop_relay.set()
        if self._executor:
            self._executor.shutdown(wait=False, cancel_futures=True)
        if self._manager:
            self._manager.shutdown()

    async def wait_idle(self) -> None:
        await self._queue.join()

    # ---------------------------------------------------------------- enregistrement
    def register_file(self, path: Path) -> tuple[int, bool]:
        digest = sha256_file(path)
        with self.sf() as db:
            existing = db.scalar(select(Demo).where(Demo.sha256 == digest))
            if existing:
                return existing.id, False
            d = Demo(path=str(path.resolve()), file_name=path.name, size=path.stat().st_size, sha256=digest,
                     status="pending", progress=0)
            db.add(d)
            db.commit()
            return d.id, True

    async def enqueue(self, demo_id: int) -> None:
        self._set_status(demo_id, "pending", 0, None)
        await self._queue.put(demo_id)

    async def import_paths(self, paths: list[Path], origin: dict | None = None) -> list[dict]:
        """`origin` : démo demandée par un outil externe ({source, external_id, opponent}), reprise dans l'événement."""
        out = []
        for p in paths:
            demo_id, created = await asyncio.to_thread(self.register_file, p)
            if created:
                await self.enqueue(demo_id)
                o = origin or {}
                await asyncio.to_thread(webhooks.emit, self.sf, "demo.imported", {
                    "demo_id": demo_id, "file_name": p.name, "source": o.get("source"),
                    "external_id": o.get("external_id"), "opponent": o.get("opponent")})
            out.append({"demo_id": demo_id, "created": created, "file_name": p.name})
        return out

    async def scan_folders(self, folders: list[Path] | None = None) -> list[dict]:
        folders = folders if folders is not None else list(self.settings.demo_folders)
        files = [p for f in folders if Path(f).is_dir() for p in sorted(Path(f).rglob("*")) if is_demo_file(p)]
        return await self.import_paths(files)

    async def reparse(self, demo_id: int) -> None:
        await self.enqueue(demo_id)

    # ---------------------------------------------------------------- exécution
    def _relay_progress(self) -> None:
        while not self._stop_relay.is_set():
            try:
                demo_id, pct, step = self._mp_queue.get(timeout=0.5)
            except Exception:
                continue
            self._publish(demo_id, "parsing", pct, step)

    def _publish(self, demo_id: int, status: str, progress: int, step: str | None,
                 error: str | None = None, match_id: int | None = None) -> None:
        self.bus.publish({"type": "demo", "demo_id": demo_id, "status": status, "progress": progress,
                          "step": step, "error": error, "match_id": match_id})

    def _notify_ready(self, match_id: int) -> None:
        """Alerte « match prêt » (comme EDGE) : en base, SSE et Discord."""
        try:
            with self.sf() as db:
                m = db.get(Match, match_id)
                if m is None:
                    return
                score = f"{m.score_a}–{m.score_b}"
                notify(db, "match_ready", f"Match prêt : {m.team_a.name} {score} {m.team_b.name}", f"{m.map_name} · démo analysée, replay et stats disponibles",
                       f"/matches/{m.id}", bus=self.bus, settings=self.settings)
        except Exception:  # noqa: BLE001  (une notification ne doit pas faire échouer l'import)
            pass

    def _emit_ready(self, match_id: int) -> None:
        """Événement « match.ready » des webhooks sortants (n8n → Discord), à la première analyse d'une démo."""
        try:
            with self.sf() as db:
                m = db.get(Match, match_id)
                if m is None:
                    return
                meta = self.maps.get(m.map_name)
                path = f"/matches/{m.id}"
                base = (self.settings.public_url or "").rstrip("/")
                us = our_team_id(db, m)  # W2 demande le débrief de cette équipe et écrit de son point de vue
                data = {"match_id": m.id, "demo_id": m.demo_id, "map": m.map_name,
                        "map_name": meta.display_name if meta else m.map_name,
                        "teams": [m.team_a.name, m.team_b.name], "score": [m.score_a, m.score_b],
                        "kind": match_kind(m), "path": path, "url": f"{base}{path}" if base else None,
                        "our_team_id": us,
                        "our_team": None if us is None else (m.team_a.name if us == m.team_a_id else m.team_b.name),
                        **sources.origin_of_demo(db, m.demo_id)}
            webhooks.emit(self.sf, "match.ready", data)
        except Exception as e:  # noqa: BLE001 — un webhook ne doit jamais faire échouer l'import
            log.warning("événement match.ready : %s", e)

    def _emit_failed(self, demo_id: int, error: str) -> None:
        try:
            with self.sf() as db:
                data = {"demo_id": demo_id, **sources.origin_of_demo(db, demo_id), "error": error}
            webhooks.emit(self.sf, "demo.failed", data)
        except Exception as e:  # noqa: BLE001
            log.warning("événement demo.failed : %s", e)

    def _set_status(self, demo_id: int, status: str, progress: int, step: str | None,
                    error: str | None = None) -> None:
        with self.sf() as db:
            d = db.get(Demo, demo_id)
            if d is None:
                return
            d.status, d.progress, d.step, d.error_message = status, progress, step, error
            db.commit()
        self._publish(demo_id, status, progress, step, error)

    async def _worker(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            demo_id = await self._queue.get()
            try:
                await self._process(loop, demo_id)
            finally:
                self._queue.task_done()

    async def _process(self, loop: asyncio.AbstractEventLoop, demo_id: int) -> None:
        with self.sf() as db:
            d = db.get(Demo, demo_id)
            if d is None:
                return
            src = Path(d.path)
            first = d.parser_version is None  # jamais analysée : une ré-analyse (nouveau parseur) n'annonce ni alerte ni webhook
        self._set_status(demo_id, "parsing", 1, "préparation")
        s = self.settings
        build_opts = {"trade_window_s": s.trade_window_s, "eco_max": s.eco_max, "semi_max": s.semi_max,
                      "force_max": s.force_max}
        try:
            path = await asyncio.to_thread(prepare_demo_file, src, s.cache_dir)
            if self._mp_queue is not None:
                parsed = await loop.run_in_executor(self._executor, _run_in_worker, self.parse_fn, str(path),
                                                    s.sample_rate, build_opts, demo_id, self._mp_queue)
            else:
                progress = lambda pct, step: self._publish(demo_id, "parsing", pct, step)
                parsed = await loop.run_in_executor(self._executor, self.parse_fn, str(path), s.sample_rate,
                                                    build_opts, progress)
            self._publish(demo_id, "parsing", 95, "écriture")
            match_id = await asyncio.to_thread(self._save, demo_id, parsed)
            self._publish(demo_id, "ready", 100, None, match_id=match_id)
            if first:  # une ré-analyse (nouveau parseur) n'annonce ni alerte ni webhook « match prêt »
                self._notify_ready(match_id)
                await asyncio.to_thread(self._emit_ready, match_id)
            if self.after_import:
                self.after_import(match_id)
        except BrokenProcessPool:
            # worker tué (le plus souvent : mémoire insuffisante) ; le pool est inutilisable, on le recrée
            old, self._executor = self._executor, self.executor_factory(max(1, s.max_parallel_imports))
            old.shutdown(wait=False, cancel_futures=True)
            msg = "Analyse interrompue : le processus de parsing a été arrêté (mémoire insuffisante ?)."
            self._set_status(demo_id, "error", 0, None, error=msg)
            if first:  # comme match.ready : une ré-analyse (nouveau parseur) n'inonde pas Discord
                await asyncio.to_thread(self._emit_failed, demo_id, msg)
        except Exception as exc:  # noqa: BLE001 — toute erreur rend la démo « error », sans bloquer la file
            msg = f"Démo illisible ou incompatible : {exc}"
            self._set_status(demo_id, "error", 0, None, error=msg)
            if first:  # comme match.ready : une ré-analyse (nouveau parseur) n'inonde pas Discord
                await asyncio.to_thread(self._emit_failed, demo_id, msg)

    def _save(self, demo_id: int, parsed: ParsedDemo) -> int:
        with self.sf() as db:
            try:
                match_id = save_parsed_demo(db, demo_id, parsed, self.maps)
                d = db.get(Demo, demo_id)
                d.status, d.progress, d.step, d.error_message = "ready", 100, None, None
                d.parser_version, d.sample_rate = PARSER_VERSION, parsed.sample_rate
                for hook in self.hooks:
                    hook(db, match_id)
                db.commit()
                return match_id
            except Exception:
                db.rollback()
                raise
