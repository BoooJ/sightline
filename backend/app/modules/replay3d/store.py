# backend/app/modules/replay3d/store.py
"""Cartes 3D du replay : fichiers .glb exportés des cartes de CS2 (scripts/map3d), rangés dans data/maps3d/<carte>/
avec un manifeste. Envoi par morceaux d'affilée, vérifié (taille, sha256, en-tête glTF 2), puis mis en place d'un coup :
l'ancienne version reste servie jusqu'à la mise en place. Ce sont des fichiers de Valve : servis à l'équipe connectée
seulement. Le mécanisme d'envoi (begin_upload, write_upload, complete_upload, clean_uploads) sert aussi aux autres
fichiers 3D (assets.py : bras et armes de la vue du joueur), chacun dans son dossier."""
from __future__ import annotations

import errno
import hashlib
import json
import logging
import math
import os
import re
import shutil
import struct
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

from app.integrations.faceit_demos import LOW_DISK

log = logging.getLogger(__name__)

VARIANTS = ("gray", "textured", "collision")
# variantes qui sont la carte elle-même : elles seules réécrivent les champs de tête du manifeste (build, exported_at,
# tool, world_to_model, checks) ; « collision » (maillage physique simplifié, corps des morts du replay 3D) les garde
MAP_VARIANTS = ("gray", "textured")
MAX_SIZE = 300 * 1024 ** 2  # un fichier de carte au plus
MAX_CHUNK = 8 * 1024 ** 2  # un morceau au plus (le script envoie 4 Mo)
STALE_S = 24 * 3600  # envoi abandonné : supprimé au bout de 24 h
SAME_FILE = ("map", "variant", "sha256", "size")  # ce qui désigne le fichier ; le reste du méta change à chaque export
DISK_FULL = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}
NO_SPACE = "Place insuffisante sur le serveur pour cette carte 3D"
MAP_RE = re.compile(r"^[a-z0-9_]{1,40}\Z")
FILE_RE = re.compile(r"^(gray|textured|collision)-[0-9a-f]{12}\.glb\Z")
ID_RE = re.compile(r"^[0-9a-f]{32}\Z")
SHA_RE = re.compile(r"^[0-9a-f]{64}\Z")
GLB_MAGIC = 0x46546C67  # « glTF » en petit-boutiste
_lock = threading.Lock()

# mise en place d'un envoi vérifié (sous verrou) : forme publique renvoyée, et ancien fichier à supprimer ensuite
Place = Callable[[Path, dict], tuple[dict, Path | None]]


class StoreError(Exception):
    """Refus avec un code HTTP, relayé tel quel par la route."""

    def __init__(self, status: int, detail):
        super().__init__(str(detail))
        self.status, self.detail = status, detail


def _root(data_dir: Path) -> Path:
    return Path(data_dir) / "maps3d"


def updir(root: Path) -> Path:
    """Dossier des envois en cours d'un type de fichiers (créé au besoin)."""
    d = root / ".uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _uploads(data_dir: Path) -> Path:
    return updir(_root(data_dir))


def _map_dir(data_dir: Path, name: str) -> Path:
    if not MAP_RE.match(name):
        raise StoreError(404, "Carte inconnue")
    return _root(data_dir) / name


def write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def manifest(data_dir: Path, name: str) -> dict | None:
    try:
        return json.loads((_map_dir(data_dir, name) / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _servable(m) -> bool:
    """Manifeste utilisable : forme publique constructible et sans nombre non fini (la réponse JSON les refuse)."""
    try:
        json.dumps(public(m), allow_nan=False)
    except (KeyError, TypeError, AttributeError, ValueError):
        return False
    return True


def list_maps(data_dir: Path) -> list[dict]:
    root = _root(data_dir)
    if not root.is_dir():
        return []
    out = []
    for d in sorted(root.iterdir()):
        if d.is_dir() and MAP_RE.match(d.name):
            m = manifest(data_dir, d.name)
            if not m:
                continue
            # un manifeste abîmé est écarté : il ferait sinon échouer toute la liste (500) pour tout le monde
            if not _servable(m):
                log.warning("Carte 3D %s : manifeste invalide, ignoré (renvoyez la carte ou supprimez-la)", d.name)
            elif m["variants"]:
                out.append(m)
    return out


def public(m: dict) -> dict:
    """Forme envoyée au navigateur : adresses des fichiers au lieu des noms et des sommes."""
    return {"map": m["map"], "build": m.get("build", ""), "exported_at": m.get("exported_at", ""),
            "world_to_model": m["world_to_model"], "checks": m.get("checks", {}),
            "variants": {v: {"url": f"/api/maps3d/{m['map']}/{x['file']}", "size": x["size"]}
                         for v, x in m["variants"].items()}}


def file_path(data_dir: Path, name: str, file: str) -> Path:
    """Fichier d'une carte, seulement s'il figure dans son manifeste (jamais un reste ni un chemin fabriqué)."""
    m = manifest(data_dir, name) if FILE_RE.match(file) else None
    if not m or not _servable(m) or file not in {x["file"] for x in m["variants"].values()}:
        raise StoreError(404, "Fichier de carte 3D introuvable")
    p = _map_dir(data_dir, name) / file
    if not p.is_file():
        raise StoreError(404, "Fichier de carte 3D introuvable")
    return p


def open_path(p: Path, missing: str) -> tuple[BinaryIO, int]:
    """Fichier ouvert et sa taille. Une fois ouvert, il reste lisible même remplacé entre-temps (Linux) ; disparu avant
    l'ouverture (course avec une mise en place), c'est un 404 et non une erreur 500."""
    try:
        f = open(p, "rb")  # noqa: SIM115  (fermé par la route, à la fin de l'envoi)
    except FileNotFoundError:
        raise StoreError(404, missing) from None
    return f, os.fstat(f.fileno()).st_size


def open_file(data_dir: Path, name: str, file: str) -> tuple[BinaryIO, int]:
    return open_path(file_path(data_dir, name, file), "Fichier de carte 3D introuvable")


def _finite(x) -> bool:
    """Nombre fini : json.loads accepte NaN, Infinity et 1e400 (lu comme l'infini), que la liste ne pourrait plus servir."""
    try:
        return isinstance(x, (int, float)) and math.isfinite(x)
    except OverflowError:  # entier démesuré
        return False


def size_sha(body: dict, max_size: int) -> tuple[int, str]:
    """Taille et somme annoncées par le script, vérifiées."""
    size, sha = body.get("size"), str(body.get("sha256", ""))
    if not isinstance(size, int) or size <= 0:
        raise StoreError(400, "Taille invalide")
    if size > max_size:
        raise StoreError(413, f"Fichier trop gros : {max_size // 1024 ** 2} Mo au plus")
    if not SHA_RE.match(sha):
        raise StoreError(400, "Somme sha256 invalide")
    return size, sha


def _meta_in(body: dict) -> dict:
    size, sha = size_sha(body, MAX_SIZE)
    w2m = body.get("world_to_model")
    if not isinstance(w2m, list) or len(w2m) != 16 or not all(_finite(x) for x in w2m):
        raise StoreError(400, "world_to_model : 16 nombres finis attendus")
    checks = body.get("checks") or {}
    if not isinstance(checks, dict) or not all(_finite(v) for v in checks.values()):
        raise StoreError(400, "checks : des nombres finis attendus")
    return {"size": size, "sha256": sha, "build": str(body.get("build", ""))[:32],
            "exported_at": str(body.get("exported_at", ""))[:40], "tool": str(body.get("tool", ""))[:40],
            "world_to_model": [float(x) for x in w2m],
            "checks": {str(k)[:20]: float(v) for k, v in list(checks.items())[:10]}}


def begin_upload(up: Path, key: str, meta: dict, same: tuple[str, ...], free: int, no_space: str = NO_SPACE) -> dict:
    """Début ou reprise d'un envoi rangé dans `up`. `key` désigne le fichier (l'identifiant d'envoi en dérive). Même
    fichier (champs `same` égaux) → on repart des octets déjà reçus ; le reste du méta (build, exported_at…, recalculé
    à chaque lancement du script) est seulement mis à jour."""
    upload_id = hashlib.sha256(key.encode()).hexdigest()[:32]
    part, mpath = up / f"{upload_id}.part", up / f"{upload_id}.json"
    with _lock:
        old = json.loads(mpath.read_text(encoding="utf-8")) if mpath.exists() and part.exists() else None
        if not old or any(old.get(k) != meta[k] for k in same):
            if free < LOW_DISK + meta["size"]:
                raise StoreError(507, no_space)
            part.write_bytes(b"")
        write_json(mpath, meta)
        return {"id": upload_id, "received": part.stat().st_size, "size": meta["size"]}


def begin(data_dir: Path, name: str, variant: str, body: dict, free: int) -> dict:
    """Début ou reprise de l'envoi d'une carte (même carte, variante, sha256 et taille → reprise)."""
    _map_dir(data_dir, name)
    if variant not in VARIANTS:
        raise StoreError(404, f"Variante inconnue ({', '.join(VARIANTS)})")
    meta = {"map": name, "variant": variant, **_meta_in(body)}
    return begin_upload(_uploads(data_dir), f"{name}:{variant}:{meta['sha256']}", meta, SAME_FILE, free)


def _paths(up: Path, upload_id: str) -> tuple[Path, Path]:
    if not ID_RE.match(upload_id):
        raise StoreError(400, "Identifiant d'envoi invalide")
    return up / f"{upload_id}.part", up / f"{upload_id}.json"


def _append(part: Path, data: bytes) -> None:
    with open(part, "ab") as f:
        f.write(data)


def write_upload(up: Path, upload_id: str, offset: int, data: bytes, free: int, no_space: str = NO_SPACE) -> dict:
    """Ajoute un morceau à la suite. La place est revérifiée à chaque morceau (la réserve LOW_DISK est partagée avec les
    imports, et d'autres envois ont pu la grignoter) : 507, et le .part reste tel qu'avant ce morceau."""
    part, mpath = _paths(up, upload_id)
    if len(data) > MAX_CHUNK:
        raise StoreError(413, "Morceau trop gros")
    with _lock:
        if not mpath.exists() or not part.exists():
            raise StoreError(404, "Envoi inconnu")
        meta = json.loads(mpath.read_text(encoding="utf-8"))
        have = part.stat().st_size
        # morceaux d'affilée seulement : un décalage faux renvoie où reprendre
        if offset != have or have + len(data) > meta["size"]:
            raise StoreError(409, {"received": have})
        if free < LOW_DISK + len(data):
            raise StoreError(507, no_space)
        try:
            _append(part, data)
        except OSError as e:
            try:  # morceau à moitié écrit : retiré, l'envoi reprendra au même décalage
                os.truncate(part, have)
            except OSError:
                pass
            if e.errno in DISK_FULL:
                raise StoreError(507, no_space) from e
            raise
        return {"received": have + len(data)}


def write_chunk(data_dir: Path, upload_id: str, offset: int, data: bytes, free: int) -> dict:
    return write_upload(_uploads(data_dir), upload_id, offset, data, free)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _is_glb(path: Path, size: int) -> bool:
    with open(path, "rb") as f:
        head = f.read(12)
    if len(head) < 12:
        return False
    magic, version, length = struct.unpack("<III", head)
    return magic == GLB_MAGIC and version == 2 and length == size


def _ready(part: Path, mpath: Path) -> dict:
    """Méta d'un envoi arrivé au bout (sous verrou) : 404 s'il n'existe plus, 409 {received} s'il manque des octets."""
    if not mpath.exists() or not part.exists():
        raise StoreError(404, "Envoi inconnu")
    meta = json.loads(mpath.read_text(encoding="utf-8"))
    have = part.stat().st_size
    if have != meta["size"]:
        raise StoreError(409, {"received": have})
    return meta


def complete_upload(up: Path, upload_id: str, place: Place) -> dict:
    """Vérifie l'envoi puis le met en place (`place`, sous verrou : renommage et manifeste) ; l'ancien fichier part
    ensuite. La somme (jusqu'à 300 Mo à lire) se calcule hors du verrou : taille atteinte, le .part ne bouge plus,
    write_upload refusant tout octet de plus. Le verrou ne couvre que les contrôles, le renommage et le manifeste."""
    part, mpath = _paths(up, upload_id)
    with _lock:
        meta = _ready(part, mpath)
    try:
        problem = None
        if _sha256(part) != meta["sha256"]:
            problem = "Somme de contrôle incorrecte : relancez l'envoi"
        elif not _is_glb(part, meta["size"]):
            problem = "Ce n'est pas un fichier glTF binaire (version 2)"
    except FileNotFoundError:  # mis en place entre-temps par un autre appel
        raise StoreError(404, "Envoi inconnu") from None
    with _lock:
        if problem:
            part.unlink(missing_ok=True)
            mpath.unlink(missing_ok=True)
            raise StoreError(400, problem)
        # un autre appel (nouvel essai après une réponse perdue) a pu finir cet envoi pendant le calcul ; un begin de
        # reprise a pu mettre à jour le méta : on relit
        meta = _ready(part, mpath)
        out, old = place(part, meta)
        mpath.unlink(missing_ok=True)
        if old is not None:
            try:
                old.unlink(missing_ok=True)
            except OSError:  # encore ouvert (Windows) : il ne figure plus au manifeste, donc plus servi
                pass
        return out


def _place_map(data_dir: Path, part: Path, meta: dict) -> tuple[dict, Path | None]:
    d = _map_dir(data_dir, meta["map"])
    d.mkdir(parents=True, exist_ok=True)
    file = f"{meta['variant']}-{meta['sha256'][:12]}.glb"
    os.replace(part, d / file)
    m = manifest(data_dir, meta["map"]) or {"map": meta["map"], "variants": {}}
    old = m["variants"].get(meta["variant"], {}).get("file")
    if meta["variant"] in MAP_VARIANTS or "world_to_model" not in m:  # collision seule : de quoi servir le manifeste
        m.update({k: meta[k] for k in ("build", "exported_at", "tool", "world_to_model", "checks")})
    m["variants"][meta["variant"]] = {"file": file, "sha256": meta["sha256"], "size": meta["size"]}
    write_json(d / "manifest.json", m)
    return public(m), (d / old if old and old != file else None)


def complete(data_dir: Path, upload_id: str) -> dict:
    """Vérifie l'envoi d'une carte, met le fichier en place et réécrit le manifeste de la carte."""
    return complete_upload(_uploads(data_dir), upload_id, lambda part, meta: _place_map(data_dir, part, meta))


def delete_map(data_dir: Path, name: str) -> None:
    d = _map_dir(data_dir, name)
    with _lock:
        if not d.is_dir():
            raise StoreError(404, "Pas de carte 3D pour cette carte")
        shutil.rmtree(d)


def clean_uploads(root: Path, now: float | None = None) -> int:
    """Supprime les envois abandonnés (plus de 24 h sans écriture) de `root`/.uploads."""
    d = root / ".uploads"
    if not d.is_dir():
        return 0
    limit, n = (now or time.time()) - STALE_S, 0
    for p in d.iterdir():
        if p.stat().st_mtime < limit:
            p.unlink(missing_ok=True)
            n += 1
    return n


def clean_stale(data_dir: Path, now: float | None = None) -> int:
    """Envois de cartes abandonnés ; appelé au chargement du module."""
    return clean_uploads(_root(data_dir), now)
