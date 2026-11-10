# backend/app/modules/replay3d/api.py
"""Routes des fichiers 3D : liste et fichiers pour les membres connectés (AuthGuard), envoi et suppression pour les
administrateurs. Cartes sous /api/maps3d, autres jeux de fichiers (bras et armes de la vue du joueur) sous
/api/assets3d. Les liens de partage public (/api/share/…) n'y donnent pas accès."""
from __future__ import annotations

from collections.abc import Iterator
from typing import BinaryIO

import anyio
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.api.deps import get_settings
from app.auth.core import require_admin
from app.core.config import Settings
from app.integrations.faceit_demos import disk_free
from app.modules.replay3d import assets, store

router = APIRouter(prefix="/api/maps3d", tags=["maps3d"])
assets_router = APIRouter(prefix="/api/assets3d", tags=["assets3d"])
CACHE = "private, max-age=31536000, immutable"  # le nom du fichier change avec son contenu
BLOCK = 1024 * 1024


def _do(fn, *args):
    try:
        return fn(*args)
    except store.StoreError as e:
        raise HTTPException(e.status, e.detail) from e


async def _chunk_body(request: Request) -> bytes:
    # taille annoncée vérifiée avant de lire le corps en mémoire ; sans Content-Length (envoi « chunked »), refusé aussi
    length = request.headers.get("content-length", "")
    if not (length.isascii() and length.isdigit()) or int(length) > store.MAX_CHUNK:
        raise HTTPException(413, f"Morceau trop gros ou de taille non annoncée : {store.MAX_CHUNK // 1024 ** 2} Mo au "
                                 "plus, avec Content-Length")
    return await request.body()


def _blocks(f: BinaryIO) -> Iterator[bytes]:
    with f:
        while block := f.read(BLOCK):
            yield block


def _serve(f: BinaryIO, size: int) -> StreamingResponse:
    return StreamingResponse(_blocks(f), media_type="model/gltf-binary",
                             headers={"Cache-Control": CACHE, "Content-Length": str(size)})


@router.get("")
def maps3d(settings: Settings = Depends(get_settings)):
    return [store.public(m) for m in store.list_maps(settings.data_dir)]


@router.put("/uploads/{upload_id}", dependencies=[Depends(require_admin)])
async def chunk(upload_id: str, offset: int, request: Request, settings: Settings = Depends(get_settings)):
    data = await _chunk_body(request)
    # verrou et disque dans un thread : la boucle d'événements, seule pour tout le site, n'attend pas
    return await anyio.to_thread.run_sync(
        lambda: _do(store.write_chunk, settings.data_dir, upload_id, offset, data, disk_free(settings.data_dir)))


@router.post("/uploads/{upload_id}/complete", dependencies=[Depends(require_admin)])
def complete(upload_id: str, settings: Settings = Depends(get_settings)):
    return _do(store.complete, settings.data_dir, upload_id)


@router.post("/{name}/{variant}/upload", dependencies=[Depends(require_admin)])
def begin(name: str, variant: str, request: Request, body: dict = Body(...), settings: Settings = Depends(get_settings)):
    if name not in request.app.state.maps:
        raise HTTPException(404, "Carte inconnue")
    return _do(store.begin, settings.data_dir, name, variant, body, disk_free(settings.data_dir))


@router.get("/{name}/{file}")
def map_file(name: str, file: str, settings: Settings = Depends(get_settings)):
    # fichier ouvert ici et non à l'envoi : remplacé entre-temps par un nouvel envoi, il donne 404 (avant l'ouverture)
    # ou reste lisible jusqu'au bout (après), jamais une erreur 500
    return _serve(*_do(store.open_file, settings.data_dir, name, file))


@router.delete("/{name}", dependencies=[Depends(require_admin)])
def remove(name: str, settings: Settings = Depends(get_settings)):
    _do(store.delete_map, settings.data_dir, name)
    return {"ok": True}


@assets_router.get("")
def assets3d(settings: Settings = Depends(get_settings)):
    return assets.list_all(settings.data_dir)


@assets_router.put("/uploads/{upload_id}", dependencies=[Depends(require_admin)])
async def asset_chunk(upload_id: str, offset: int, request: Request, settings: Settings = Depends(get_settings)):
    data = await _chunk_body(request)
    return await anyio.to_thread.run_sync(
        lambda: _do(assets.write_chunk, settings.data_dir, upload_id, offset, data, disk_free(settings.data_dir)))


@assets_router.post("/uploads/{upload_id}/complete", dependencies=[Depends(require_admin)])
def asset_complete(upload_id: str, settings: Settings = Depends(get_settings)):
    return _do(assets.complete, settings.data_dir, upload_id)


@assets_router.post("/{kind}/{name}/upload", dependencies=[Depends(require_admin)])
def asset_begin(kind: str, name: str, body: dict = Body(...), settings: Settings = Depends(get_settings)):
    return _do(assets.begin, settings.data_dir, kind, name, body, disk_free(settings.data_dir))


@assets_router.get("/{kind}/{file}")
def asset_file(kind: str, file: str, settings: Settings = Depends(get_settings)):
    return _serve(*_do(assets.open_file, settings.data_dir, kind, file))
