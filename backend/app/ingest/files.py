# backend/app/ingest/files.py
from __future__ import annotations

import bz2
import hashlib
import shutil
from pathlib import Path

DEMO_EXTENSIONS = (".dem", ".dem.bz2")


def is_demo_file(path: Path) -> bool:
    name = path.name.lower()
    return path.is_file() and name.endswith(DEMO_EXTENSIONS)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def prepare_demo_file(path: Path, cache_dir: Path) -> Path:
    """Renvoie un chemin .dem lisible par demoparser2 (décompresse les .bz2 dans le cache)."""
    if not path.name.lower().endswith(".bz2"):
        return path
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / path.name[:-4]
    if not out.exists():
        tmp = out.with_suffix(".part")
        with bz2.open(path, "rb") as src, open(tmp, "wb") as dst:
            shutil.copyfileobj(src, dst, 8 * 1024 * 1024)
        tmp.replace(out)
    return out
