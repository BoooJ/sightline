# backend/app/api/uploads.py
"""Upload par morceaux, reprenable et parallèle : une démo de 500 Mo sur une connexion lente ne doit pas tout
recommencer au moindre incident réseau, et la latence ne doit pas brider le débit.

Le client choisit un identifiant stable (empreinte nom + taille + date). Chaque morceau est écrit à sa position
(plusieurs morceaux peuvent arriver en même temps, dans n'importe quel ordre) ; le serveur tient la liste des plages
reçues. Après une coupure ou un rechargement de page, le client redemande ces plages et n'envoie que ce qui manque."""
import asyncio
import json
import os
import re
from pathlib import Path

import zstandard as zstd
from fastapi import APIRouter, Body, Depends, HTTPException, Request

from app.api.deps import get_service, get_settings
from app.core.config import Settings
from app.ingest.files import DEMO_EXTENSIONS
from app.ingest.service import ImportService

router = APIRouter(prefix="/api/uploads", tags=["uploads"])
_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_CHUNK = 64 * 1024 * 1024
MAX_SIZE = {"demo": 4 * 1024**3, "audio": 1024**3}  # une démo CS2 fait rarement plus de 1 Go
# .dem.zst : démo compressée par l'outil d'import HLTV (un tiers plus légère à envoyer), décompressée à la réception
UPLOAD_DEMO_EXTENSIONS = (*DEMO_EXTENSIONS, ".dem.zst")
AUDIO_EXTENSIONS = (".mp3", ".ogg", ".opus", ".m4a", ".aac", ".wav", ".webm", ".flac")
_locks: dict[str, asyncio.Lock] = {}


def _paths(settings: Settings, upload_id: str) -> tuple[Path, Path]:
    if not _ID.match(upload_id):
        raise HTTPException(400, "Identifiant d'upload invalide")
    d = settings.uploads_dir / ".partial"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{upload_id}.part", d / f"{upload_id}.name"


def _meta(meta: Path) -> dict:
    """Métadonnées : JSON {name, size, kind, ranges} (ancien format texte « nom\\ntaille[\\ntype] » accepté)."""
    raw = meta.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except ValueError:
        lines = raw.split("\n")
        part = meta.with_suffix(".part")
        have = part.stat().st_size if part.exists() else 0
        return {"name": lines[0], "size": int(lines[1]), "kind": lines[2] if len(lines) > 2 else "demo",
                "ranges": [[0, have]] if have else []}


def _merge(ranges: list[list[int]]) -> list[list[int]]:
    out: list[list[int]] = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def _prefix(ranges: list[list[int]]) -> int:
    """Octets reçus d'affilée depuis le début (rétrocompatibilité avec les clients séquentiels)."""
    return ranges[0][1] if ranges and ranges[0][0] == 0 else 0


def _status(m: dict) -> dict:
    return {"received": _prefix(m["ranges"]), "ranges": m["ranges"], "size": m["size"]}


@router.post("")
def start(body: dict = Body(...), settings: Settings = Depends(get_settings)):
    upload_id, name = str(body.get("id", "")), Path(str(body.get("name", ""))).name
    kind = "audio" if body.get("kind") == "audio" else "demo"
    allowed = AUDIO_EXTENSIONS if kind == "audio" else UPLOAD_DEMO_EXTENSIONS
    if not name.lower().endswith(allowed):
        raise HTTPException(400, f"Format non supporté : {name} (attendu {', '.join(allowed)})")
    part, meta = _paths(settings, upload_id)
    size = int(body.get("size", 0))
    if not 0 <= size <= MAX_SIZE[kind]:
        raise HTTPException(413, "Fichier trop volumineux")
    m = _meta(meta) if meta.exists() else None
    if m is None or m["size"] != size or m["name"] != name:
        m = {"name": name, "size": size, "kind": kind, "ranges": []}
        part.unlink(missing_ok=True)
        meta.write_text(json.dumps(m), encoding="utf-8")
    return {"id": upload_id, **_status(m)}


def take_upload(settings: Settings, upload_id: str, kind: str) -> tuple[str, Path]:
    """Vérifie qu'un upload est complet et du bon type ; renvoie (nom d'origine, fichier .part)."""
    part, meta = _paths(settings, upload_id)
    if not meta.exists():
        raise HTTPException(404, "Upload inconnu")
    m = _meta(meta)
    if m["kind"] != kind:
        raise HTTPException(400, "Type de fichier inattendu pour cet upload")
    if m["ranges"] != [[0, m["size"]]] and not (m["size"] == 0 and not m["ranges"]):
        raise HTTPException(409, detail=_status(m))
    meta.unlink(missing_ok=True)
    _locks.pop(upload_id, None)
    return m["name"], part


@router.put("/{upload_id}")
async def chunk(upload_id: str, offset: int, request: Request, settings: Settings = Depends(get_settings)):
    part, meta = _paths(settings, upload_id)
    if not meta.exists():
        raise HTTPException(404, "Upload inconnu")
    data = await request.body()
    if len(data) > MAX_CHUNK:
        raise HTTPException(413, "Morceau trop gros")
    lock = _locks.setdefault(upload_id, asyncio.Lock())
    async with lock:
        m = _meta(meta)
        if offset < 0 or offset + len(data) > m["size"]:
            raise HTTPException(409, detail=_status(m))
        # écriture à la position du morceau : les morceaux peuvent arriver dans n'importe quel ordre, ou en double
        mode = "r+b" if part.exists() else "wb"
        with open(part, mode) as f:
            f.seek(offset)
            f.write(data)
        if data:
            m["ranges"] = _merge([*m["ranges"], [offset, offset + len(data)]])
        meta.write_text(json.dumps(m), encoding="utf-8")
    return _status(m)


def _unzstd(src: Path, dst: Path) -> None:
    with open(src, "rb") as i, open(dst, "wb") as o:
        zstd.ZstdDecompressor().copy_stream(i, o, read_size=1 << 20, write_size=1 << 20)


@router.post("/{upload_id}/complete")
async def complete(upload_id: str, svc: ImportService = Depends(get_service),
                   settings: Settings = Depends(get_settings)):
    name, part = take_upload(settings, upload_id, "demo")
    if name.lower().endswith(".zst"):
        name = name[:-4]
        raw = part.with_suffix(".dem")
        try:
            await asyncio.to_thread(_unzstd, part, raw)
        except zstd.ZstdError as e:
            part.unlink(missing_ok=True)
            raise HTTPException(400, "Fichier .zst invalide") from e
        part.unlink(missing_ok=True)
        part = raw
    dest = settings.uploads_dir / name
    if dest.exists():  # même nom, autre contenu : on ne remplace pas une démo déjà importée
        stem = name[: -len(next(e for e in DEMO_EXTENSIONS if name.lower().endswith(e)))]
        dest = settings.uploads_dir / f"{stem}-{upload_id[:8]}{name[len(stem):]}"
    os.replace(part, dest)
    return (await svc.import_paths([dest]))[0]
