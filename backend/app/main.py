# backend/app/main.py
from __future__ import annotations

import threading
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware

from app.api import (ai, debrief, annotations, audio, auth, bookmarks, calendar, callouts, comments, compare, context, discord, evals, notes, notifications, pattern, prep, push, scout_players, share, tactics, vetos, faceit, highlights, live, demos, events, grenades, heatmaps, integrations, maps, matches, players, playlists,
                     playbook, rounds, scouting, settings as settings_api, strats, teams, uploads)
import logging
import secrets

from app.auth.core import has_users, is_local, request_token, user_from_token
from app.integrations import comms, keys as api_keys, sources as demo_sources
from app.core.config import Settings, load_settings
from app.faceit import link as faceit_link
from app.core.db import init_db, make_engine, make_session_factory
from app.ingest.bus import ProgressBus
from app.stats.cache import LibraryCache, enable_disk
from app.ingest.service import ImportService, default_parse
from app.maps import callouts as callout_zones
from app.maps.registry import load_maps
from app.modules import ModuleRegistry, load_modules

VERSION = "0.1.0"


def create_app(settings: Settings | None = None, parse_fn=None, executor_factory=None) -> FastAPI:
    settings = settings or load_settings()
    registry = ModuleRegistry()
    registry.post_import_hooks.append(faceit_link.import_hook)  # démos rattachées aux équipes FACEIT suivies

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db(settings.db_url)
        enable_disk(settings.data_dir)  # les calculs coûteux survivent aux redémarrages
        engine = make_engine(settings.db_url)
        app.state.session_factory = make_session_factory(engine)
        demo_sources.reset_interrupted(app.state.session_factory)  # téléchargements coupés : l'outil les reprendra
        app.state.service = ImportService(settings, app.state.session_factory, app.state.bus,
                                          parse_fn=parse_fn or default_parse, executor_factory=executor_factory,
                                          post_import_hooks=registry.post_import_hooks)
        def warm_caches(match_id: int | None = None):
            if match_id is not None:
                LibraryCache.bump()
                matches.forget_match(match_id)  # ré-analyse : même id de match, nouvelles données

            def run():
                try:
                    players.warm(app.state.session_factory, app.state.maps)
                except Exception:  # noqa: BLE001 — simple préchauffage : l'API recalculera à la demande
                    pass
            threading.Thread(target=run, daemon=True, name="warm-caches").start()

        with app.state.session_factory() as db:
            if not has_users(db):
                app.state.setup_code = secrets.token_hex(4).upper()
                logging.getLogger("uvicorn.error").warning(
                    "Aucun compte : code d'installation du compte propriétaire = %s", app.state.setup_code)
        def after_import(match_id: int) -> None:
            warm_caches(match_id)
            # comms TeamSpeak qui attendaient la démo de ce match (fil à part : l'import a déjà rendu la main)
            threading.Thread(target=comms.retry_waiting, args=(app.state, match_id), daemon=True,
                             name="comms-retry").start()
        app.state.service.after_import = after_import
        await app.state.service.start()
        if settings.warm_caches:
            warm_caches()
        yield
        await app.state.service.stop()
        engine.dispose()

    app = FastAPI(title="Skybox CS", version=VERSION, lifespan=lifespan)
    app.state.settings = settings
    app.state.bus = ProgressBus()
    app.state.maps = load_maps(settings.maps_dir)
    callout_zones.configure(settings.data_dir / "callouts")  # zones redessinées par l'équipe (page Callouts)
    app.state.registry = registry
    app.state.setup_code = None
    app.add_middleware(AuthGuard, app_state=app.state)

    # replays (msgpack), JS et JSON : ÷4 à ÷6 sur le réseau ; le flux SSE n'est pas compressé par Starlette, ni les .glb
    # de la 3D (cartes, bras et armes : déjà compressés par meshopt et WebP, gzip n'y gagne presque rien et coûte du CPU
    # au serveur, 2 cœurs, environ 47 Mo par nouveau poste)
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6,
                       exclude_content_types=(*DEFAULT_EXCLUDED_CONTENT_TYPES, "model/gltf-binary"))
    # 5173 : site en développement (Vite) ; 8081 : app mobile en développement (Expo web)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173",
                                                      "http://localhost:8081", "http://127.0.0.1:8081"],
                       allow_methods=["*"], allow_headers=["*"])

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": VERSION, "modules": registry.loaded}

    routers = (demos, events, matches, rounds, maps, settings_api, uploads, players, playlists, teams, grenades,
               heatmaps, annotations, auth, comments, scouting, audio, strats, callouts, highlights, calendar, live, bookmarks, ai,
               faceit, evals, context, compare, tactics, pattern, share, prep, vetos, scout_players, notifications, debrief, push, notes, integrations, discord, playbook)
    for r in (mod.router for mod in routers):
        app.include_router(r)
    load_modules(app, settings.modules, registry)

    if settings.maps_dir.exists():
        app.mount("/maps", CachedStatic(directory=settings.maps_dir, max_age=7 * 86400), name="maps")

    mob: Path = settings.mobile_dist
    if (mob / "index.html").exists():  # app mobile, version web (Expo, baseUrl /app) : avant la route attrape-tout du site
        for sub in ("_expo", "assets"):  # noms à empreinte de contenu : immuables
            if (mob / sub).is_dir():
                app.mount(f"/app/{sub}", CachedStatic(directory=mob / sub, max_age=365 * 86400, immutable=True),
                          name=f"m-{sub}")

        @app.get("/app", include_in_schema=False)
        def mobile_root():
            return RedirectResponse("/app/", status_code=308)

        @app.api_route("/app/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
        def mobile(path: str):
            f = (mob / path).resolve()
            if path and f.is_relative_to(mob.resolve()) and f.is_file():
                return FileResponse(f, headers={"Cache-Control": "no-cache"})  # sw.js, manifest, icônes
            return FileResponse(mob / "index.html", headers={"Cache-Control": "no-cache"})

    dist: Path = settings.frontend_dist
    if (dist / "index.html").exists():
        # fichiers à empreinte de contenu (index-XXXX.js) : immuables, jamais revalidés
        app.mount("/assets", CachedStatic(directory=dist / "assets", max_age=365 * 86400, immutable=True), name="assets")
        if (dist / "weapons").is_dir():  # icônes d'armes : stables, gardées 30 jours
            app.mount("/weapons", CachedStatic(directory=dist / "weapons", max_age=30 * 86400), name="weapons")

        @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404)
            f = (dist / path).resolve()
            # « ../ » (même encodé %2e%2e%2f) sortirait du dossier du frontend : lecture de la base, des secrets…
            if path and f.is_relative_to(dist.resolve()) and f.is_file():
                return FileResponse(f)
            # la page d'entrée référence les fichiers du dernier déploiement : toujours revalidée
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})

    return app


class CachedStatic(StaticFiles):
    """Fichiers statiques avec un Cache-Control explicite (sinon le navigateur revalide chaque fichier à chaque visite,
    soit un aller-retour réseau par fichier)."""

    def __init__(self, *args, max_age: int, immutable: bool = False, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.cache_control = f"public, max-age={max_age}" + (", immutable" if immutable else "")

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = self.cache_control
        return resp


class AuthGuard:
    """Dès qu'un compte existe, l'API exige une session (sauf santé et authentification) ou une clé d'API, limitée à ses droits. Middleware ASGI pur : contrairement à BaseHTTPMiddleware, il ne bloque pas les réponses en flux (SSE)."""

    def __init__(self, app, app_state) -> None:
        self.app, self.state = app, app_state

    def _check(self, token: str | None, local: bool, method: str, path: str) -> tuple[int, dict | None]:
        """Code HTTP (200 = accès) et, pour une clé d'API, ses droits. Un jeton `sl_…` inconnu retombe sur les
        sessions : un jeton de session pourrait commencer par ces trois caractères."""
        with self.state.session_factory() as db:
            key = api_keys.lookup(db, token)
            if key is not None:
                scopes = api_keys.scopes_of(key)
                if not api_keys.allows(scopes, method, path):
                    return 403, None
                return 200, {"id": key.id, "scopes": scopes}
            if not has_users(db):
                return (200 if local else 401), None  # sans compte, seule la machine elle-même accède aux données
            return (200 if user_from_token(db, token) is not None else 401), None

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        public = path == "/api/health" or path.startswith("/api/auth/") \
            or (path.startswith("/api/share/") and scope.get("method") == "GET") \
            or path == "/api/discord/interactions"  # liens de partage publics ; Discord, vérifié par sa signature
        if scope["type"] == "http" and path.startswith("/api/") and not public:
            req = Request(scope)
            code, key = await anyio.to_thread.run_sync(self._check, request_token(req), is_local(req),
                                                        scope.get("method", "GET"), path)
            if code != 200:
                detail = "Connexion requise" if code == 401 else "Action non permise pour cette clé d'API"
                await JSONResponse({"detail": detail}, status_code=code)(scope, receive, send)
                return
            if key is not None:  # lu par app.api.integrations.require_key via request.state
                scope.setdefault("state", {})["api_key"] = key
        await self.app(scope, receive, send)


def get_app() -> FastAPI:
    return create_app()
