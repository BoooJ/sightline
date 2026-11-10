# backend/app/modules/replay3d/assets.py
"""Fichiers 3D autres que les cartes, rangés par type dans data/assets3d/<type>/<nom>-<sha12>.glb avec un manifeste :
`vue` = bras et armes de la vue du joueur (scripts/map3d/export.mjs vue) ; `joueurs` = joueurs vus de l'extérieur
(modèles d'agents, clips, armes du monde : export.mjs joueurs). Même envoi par morceaux, mêmes vérifications et même mise
en place que les cartes (store.py), dans un dossier d'envois à part. Ce sont des fichiers de Valve : servis à l'équipe
connectée seulement."""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import BinaryIO

from app.modules.replay3d import store
from app.modules.replay3d.store import StoreError

log = logging.getLogger(__name__)

KINDS = ("vue", "joueurs")
MAX_SIZE = 64 * 1024 ** 2  # un fichier au plus (bras + arme optimisés : 1 à 2 Mo ; clips d'une classe : 2,5 Mo)
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}\Z")
FILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}-[0-9a-f]{12}\.glb\Z")
SAME_FILE = ("kind", "name", "sha256", "size")
NO_SPACE = "Place insuffisante sur le serveur pour ces fichiers 3D"
MISSING = "Fichier 3D introuvable"


def _root(data_dir: Path) -> Path:
    return Path(data_dir) / "assets3d"


def _uploads(data_dir: Path) -> Path:
    return store.updir(_root(data_dir))


def _kind_dir(data_dir: Path, kind: str) -> Path:
    if kind not in KINDS:
        raise StoreError(404, "Type de fichiers 3D inconnu")
    return _root(data_dir) / kind


def manifest(data_dir: Path, kind: str) -> dict | None:
    try:
        return json.loads((_kind_dir(data_dir, kind) / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def public(kind: str, m: dict) -> dict:
    """Forme envoyée au navigateur : adresse et taille de chaque fichier, par nom."""
    return {"build": m.get("build", ""), "exported_at": m.get("exported_at", ""),
            "files": {n: {"url": f"/api/assets3d/{kind}/{x['file']}", "size": x["size"]} for n, x in m["files"].items()}}


def _servable(kind: str, m) -> bool:
    try:
        json.dumps(public(kind, m), allow_nan=False)
    except (KeyError, TypeError, AttributeError, ValueError):
        return False
    return True


def list_all(data_dir: Path) -> dict:
    """Types qui ont au moins un fichier : {type: forme publique}. Un manifeste abîmé est écarté (journal)."""
    out = {}
    for kind in KINDS:
        m = manifest(data_dir, kind)
        if not m:
            continue
        if not _servable(kind, m):
            log.warning("Fichiers 3D %s : manifeste invalide, ignoré (renvoyez les fichiers)", kind)
        elif m["files"]:
            out[kind] = public(kind, m)
    return out


def file_path(data_dir: Path, kind: str, file: str) -> Path:
    """Fichier d'un type, seulement s'il figure dans son manifeste (jamais un reste ni un chemin fabriqué)."""
    m = manifest(data_dir, kind) if FILE_RE.match(file) else None
    if not m or not _servable(kind, m) or file not in {x["file"] for x in m["files"].values()}:
        raise StoreError(404, MISSING)
    p = _kind_dir(data_dir, kind) / file
    if not p.is_file():
        raise StoreError(404, MISSING)
    return p


def open_file(data_dir: Path, kind: str, file: str) -> tuple[BinaryIO, int]:
    return store.open_path(file_path(data_dir, kind, file), MISSING)


def begin(data_dir: Path, kind: str, name: str, body: dict, free: int) -> dict:
    """Début ou reprise d'un envoi (même type, nom, sha256 et taille → reprise)."""
    _kind_dir(data_dir, kind)
    if not NAME_RE.match(name):
        raise StoreError(404, "Nom de fichier 3D invalide")
    size, sha = store.size_sha(body, MAX_SIZE)
    meta = {"kind": kind, "name": name, "size": size, "sha256": sha, "build": str(body.get("build", ""))[:32],
            "exported_at": str(body.get("exported_at", ""))[:40], "tool": str(body.get("tool", ""))[:40]}
    return store.begin_upload(_uploads(data_dir), f"{kind}:{name}:{sha}", meta, SAME_FILE, free, NO_SPACE)


def write_chunk(data_dir: Path, upload_id: str, offset: int, data: bytes, free: int) -> dict:
    return store.write_upload(_uploads(data_dir), upload_id, offset, data, free, NO_SPACE)


def _place(data_dir: Path, part: Path, meta: dict) -> tuple[dict, Path | None]:
    kind = meta["kind"]
    d = _kind_dir(data_dir, kind)
    d.mkdir(parents=True, exist_ok=True)
    file = f"{meta['name']}-{meta['sha256'][:12]}.glb"
    os.replace(part, d / file)
    m = manifest(data_dir, kind)
    if not m or not _servable(kind, m):  # absent ou abîmé : on repart d'un manifeste vide
        m = {"kind": kind, "files": {}}
    old = (m["files"].get(meta["name"]) or {}).get("file")
    m.update({k: meta[k] for k in ("build", "exported_at", "tool")})
    m["files"][meta["name"]] = {"file": file, "sha256": meta["sha256"], "size": meta["size"]}
    store.write_json(d / "manifest.json", m)
    return public(kind, m), (d / old if isinstance(old, str) and FILE_RE.match(old) and old != file else None)


def complete(data_dir: Path, upload_id: str) -> dict:
    """Vérifie l'envoi, met le fichier en place, réécrit le manifeste du type ; l'ancien fichier du même nom part."""
    return store.complete_upload(_uploads(data_dir), upload_id, lambda part, meta: _place(data_dir, part, meta))


def clean_stale(data_dir: Path, now: float | None = None) -> int:
    """Envois abandonnés (plus de 24 h) ; appelé au chargement du module."""
    return store.clean_uploads(_root(data_dir), now)
