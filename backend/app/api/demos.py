# backend/app/api/demos.py
import asyncio
import secrets
import shutil
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_service, get_session, get_settings
from app.auth.core import require_admin
from app.core.config import Settings
from app.ingest import remote
from app.ingest.files import DEMO_EXTENSIONS
from app.ingest.service import ImportService
from app.integrations import sources, webhooks
from app.storage.models import Demo, FaceitDemo, MatchAudio
from app.storage.repository import delete_demo, demo_to_dict

router = APIRouter(prefix="/api/demos", tags=["demos"])


@router.get("")
def list_demos(db: Session = Depends(get_session)):
    return [demo_to_dict(d) for d in db.scalars(select(Demo).order_by(Demo.id.desc()))]


@router.post("/upload")
async def upload(files: list[UploadFile], svc: ImportService = Depends(get_service),
                 settings: Settings = Depends(get_settings)):
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for f in files:
        name = Path(f.filename or "demo.dem").name
        if not name.lower().endswith(DEMO_EXTENSIONS):
            raise HTTPException(400, f"Format non supporté : {name} (attendu .dem ou .dem.bz2)")
        dest = settings.uploads_dir / name
        with open(dest, "wb") as out:
            shutil.copyfileobj(f.file, out, 8 * 1024 * 1024)
        paths.append(dest)
    return await svc.import_paths(paths)


@router.post("/scan")
async def scan(body: dict = Body(default={}), svc: ImportService = Depends(get_service),
               settings: Settings = Depends(get_settings), _=Depends(require_admin)):
    # chemins arbitraires du serveur : réservé aux administrateurs
    folders = [Path(p) for p in body.get("folders", [])] or list(settings.demo_folders)
    missing = [str(f) for f in folders if not f.is_dir()]
    if folders and len(missing) == len(folders):
        # cas typique : un chemin de la machine locale (C:\…) saisi alors que l'app tourne sur un serveur
        raise HTTPException(400, "Dossier introuvable sur le serveur : " + ", ".join(missing)
                            + ". Pour des démos de votre ordinateur, utilisez « Importer des démos ».")
    return await svc.scan_folders(folders)


@router.post("/{demo_id}/reparse")
async def reparse(demo_id: int, db: Session = Depends(get_session), svc: ImportService = Depends(get_service)):
    if db.get(Demo, demo_id) is None:
        raise HTTPException(404, "Démo introuvable")
    await svc.reparse(demo_id)
    return {"ok": True}


@router.get("/{demo_id}/file")
def download(demo_id: int, db: Session = Depends(get_session)):
    """Télécharge la démo d'origine (comme « Download demo » d'EDGE)."""
    d = db.get(Demo, demo_id)
    if d is None or not Path(d.path).exists():
        raise HTTPException(404, "Fichier de démo introuvable")
    return FileResponse(d.path, media_type="application/octet-stream", filename=d.file_name or Path(d.path).name)


@router.delete("/{demo_id}")
def remove(demo_id: int, db: Session = Depends(get_session), settings: Settings = Depends(get_settings)):
    d = db.get(Demo, demo_id)
    if d is None:
        raise HTTPException(404, "Démo introuvable")
    path = Path(d.path)
    # fichiers liés : pistes audio des comms, démo décompressée en cache (sinon ils restent sur le disque)
    files = [Path(a.path) for a in db.scalars(select(MatchAudio).where(MatchAudio.demo_id == demo_id))]
    if path.name.lower().endswith(".bz2"):
        files.append(settings.cache_dir / path.name[:-4])
    delete_demo(db, demo_id)
    db.commit()
    owned = (settings.uploads_dir.resolve(), settings.data_dir.resolve())
    for f in [path, *files]:
        try:
            if any(f.resolve().is_relative_to(root) for root in owned):
                f.unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True}


# ---------------------------------------------------------------------------- import par lien
_downloads: dict[str, "remote.Download"] = {}
_tasks: set = set()  # référence gardée : une tâche asyncio sans référence peut être collectée en cours de route


@router.post("/import-url")
async def import_url(body: dict = Body(...), svc: ImportService = Depends(get_service),
                     settings: Settings = Depends(get_settings)):
    """Télécharge une démo depuis un lien (lien direct, lien de téléchargement FACEIT, page de match FACEIT si une clé
    d'API est configurée) puis l'importe. Suivi : GET /api/demos/remote."""
    url = str(body.get("url") or "").strip()
    try:
        await asyncio.to_thread(remote.check_url, url)
        if remote.FACEIT_ROOM.search(url) and not remote.faceit_key(settings.data_dir):
            remote.faceit_demo_url(url, None)  # message d'aide : quel lien copier
    except remote.RemoteError as e:
        raise HTTPException(400, str(e))
    return start_download(remote.Download(id=secrets.token_hex(6), url=url), svc, settings)


def start_download(dl: "remote.Download", svc: ImportService, settings: Settings, origin: dict | None = None) -> dict:
    """Lance le téléchargement puis l'import en tâche de fond (suivi : GET /api/demos/remote). `origin` : démo demandée
    par un outil externe ({source_id, source, external_id, opponent}) ; sa ligne demo_sources suit le téléchargement."""
    _downloads[dl.id] = dl
    for old in sorted(_downloads.values(), key=lambda d: d.started)[:-20]:
        _downloads.pop(old.id, None)

    async def run():
        try:
            paths = await asyncio.to_thread(remote.download, dl, settings.uploads_dir, remote.faceit_key(settings.data_dir))
            dl.status = "importing"
            if origin:
                await asyncio.to_thread(sources.set_status, svc.sf, origin["source_id"], "importing")
            res = await svc.import_paths(paths, origin=origin)
            dl.demo_id = res[0]["demo_id"]
            if origin:
                await asyncio.to_thread(sources.mark_done, svc.sf, origin["source_id"], res[0]["demo_id"], res[0]["created"])
            if dl.faceit_match:  # démo d'un match FACEIT : rattachée au match pour la fiche de scouting
                with svc.sf() as db:
                    for r in res:
                        db.merge(FaceitDemo(demo_id=r["demo_id"], match_id=dl.faceit_match))
                    db.commit()
            dl.status = "done"
        except remote.RemoteError as e:
            dl.status, dl.error = "error", str(e)
        except Exception as e:  # noqa: BLE001 — toute erreur est affichée dans la liste des imports
            dl.status, dl.error = "error", f"Échec du téléchargement : {e}"
        if dl.status == "error":
            await asyncio.to_thread(download_failed, svc, dl, origin)

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return dl.to_dict()


def download_failed(svc: ImportService, dl: "remote.Download", origin: dict | None) -> None:
    """Téléchargement ou import raté : la demande de l'outil compte un échec, les webhooks sont prévenus."""
    o = origin or {}
    if origin:
        sources.mark_failed(svc.sf, origin["source_id"], dl.error or "")
    webhooks.emit(svc.sf, "demo.failed", {"demo_id": None, "source": o.get("source"), "external_id": o.get("external_id"),
                                          "opponent": o.get("opponent"), "error": dl.error})


@router.get("/remote")
def remote_downloads():
    return [d.to_dict() for d in sorted(_downloads.values(), key=lambda d: -d.started)]
