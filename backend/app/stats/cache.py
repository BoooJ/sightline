# backend/app/stats/cache.py
"""Cache LRU des calculs coûteux (heatmaps, rôles, histoires de rounds…), invalidé dès que la bibliothèque change.

En mémoire, et en plus sur disque (`cache.sqlite` dans le dossier de données) quand `enable_disk` a été appelé au
démarrage : un redémarrage du serveur ne fait alors plus attendre le premier affichage de chaque page. Les clés et
les valeurs sont nos propres objets Python, sérialisés avec pickle."""
from __future__ import annotations

import pickle
import sqlite3
from collections import OrderedDict
from pathlib import Path
from threading import Lock
from typing import Any, Callable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.storage.models import Demo, Match

DISK_MAX_ROWS = 20_000  # au-delà, les entrées les plus anciennes sont retirées


# version des calculs : à changer quand une formule change (rating, probabilité de victoire, classes de rounds…),
# pour que les entrées sur disque d'un ancien code ne soient plus servies après un déploiement
CALC_VERSION = "2026-10-16-default-phases"


class _Disk:
    """Table clé → valeur dans un fichier SQLite, partagée par tous les caches (une colonne `cache` les distingue)."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._c = sqlite3.connect(str(path), check_same_thread=False)
        self._c.execute("PRAGMA journal_mode=WAL")
        self._c.execute("CREATE TABLE IF NOT EXISTS entries (cache TEXT, key BLOB, value BLOB, at REAL DEFAULT (unixepoch('subsec')), PRIMARY KEY (cache, key))")
        self._c.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)")
        self._c.commit()
        self._lock = Lock()

    def get(self, cache: str, key: bytes) -> Any | None:
        cache = f"{CALC_VERSION}:{cache}"
        with self._lock:
            row = self._c.execute("SELECT value FROM entries WHERE cache = ? AND key = ?", (cache, key)).fetchone()
        if row is None:
            return None
        try:
            return pickle.loads(row[0])
        except Exception:  # noqa: BLE001 — entrée d'une version précédente du code : ignorée, recalculée
            return None

    def put(self, cache: str, key: bytes, value: Any) -> None:
        cache = f"{CALC_VERSION}:{cache}"
        try:
            blob = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
        except Exception:  # noqa: BLE001 — valeur non sérialisable : reste en mémoire seulement
            return
        with self._lock:
            self._c.execute("INSERT OR REPLACE INTO entries (cache, key, value) VALUES (?, ?, ?)", (cache, key, blob))
            self._c.execute("DELETE FROM entries WHERE rowid IN (SELECT rowid FROM entries ORDER BY at DESC LIMIT -1 OFFSET ?)", (DISK_MAX_ROWS,))
            self._c.commit()

    def keys(self, cache: str) -> list[tuple[bytes, Any]]:
        cache = f"{CALC_VERSION}:{cache}"
        with self._lock:
            rows = self._c.execute("SELECT key FROM entries WHERE cache = ?", (cache,)).fetchall()
        out = []
        for (kb,) in rows:
            try:
                out.append((kb, pickle.loads(kb)))
            except Exception:  # noqa: BLE001
                continue
        return out

    def delete(self, cache: str, keys: list[bytes]) -> None:
        cache = f"{CALC_VERSION}:{cache}"
        with self._lock:
            self._c.executemany("DELETE FROM entries WHERE cache = ? AND key = ?", [(cache, k) for k in keys])
            self._c.commit()

    def clear(self) -> None:
        with self._lock:
            self._c.execute("DELETE FROM entries")
            self._c.commit()

    def meta_get(self, k: str, default: int) -> int:
        with self._lock:
            row = self._c.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
        return int(row[0]) if row else default

    def meta_set(self, k: str, v: int) -> None:
        with self._lock:
            self._c.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, v))
            self._c.commit()


_disk: _Disk | None = None
_caches: list["LibraryCache"] = []


def enable_disk(data_dir: Path) -> None:
    """À appeler au démarrage : les caches déjà créés et ceux à venir gardent aussi leurs entrées sur disque."""
    global _disk
    _disk = _Disk(Path(data_dir) / "cache.sqlite")
    LibraryCache.generation = _disk.meta_get("generation", LibraryCache.generation)


def disable_disk() -> None:
    global _disk
    _disk = None


class LibraryCache:
    generation = 0  # incrémenté à chaque import terminé : une ré-analyse ne change ni le nombre ni les dates des matchs

    def __init__(self, size: int = 64, name: str | None = None) -> None:
        self.size = size
        self.name = name or f"cache{len(_caches)}"
        self._d: OrderedDict = OrderedDict()
        self._lock = Lock()
        _caches.append(self)

    @classmethod
    def bump(cls) -> None:
        """La bibliothèque a changé sans que ses compteurs bougent (ré-analyse, équipes modifiées) : tout est à refaire."""
        cls.generation += 1
        if _disk is not None:
            _disk.meta_set("generation", cls.generation)

    @classmethod
    def clear_all(cls) -> None:
        """Tout oublier, y compris les calculs par match (`get_fixed`) : les noms des zones de callouts ont changé."""
        cls.bump()
        for c in _caches:
            with c._lock:
                c._d.clear()
        if _disk is not None:
            _disk.clear()

    @staticmethod
    def version(db: Session) -> tuple:
        return (LibraryCache.generation,) + tuple(db.execute(select(func.count(Match.id), func.max(Match.id), func.max(Demo.imported_at))
                                .select_from(Match).join(Demo, Demo.id == Match.demo_id)).one())

    def get(self, db: Session, key: Any, compute: Callable[[], Any]) -> Any:
        return self.get_fixed((key, self.version(db)), compute)

    def drop(self, pred: Callable[[Any], bool]) -> None:
        """Oublie les entrées dont la clé vérifie `pred` (ex. un match ré-analysé, qui garde le même id)."""
        with self._lock:
            for k in [k for k in self._d if pred(k)]:
                del self._d[k]
        if _disk is not None:
            _disk.delete(self.name, [kb for kb, k in _disk.keys(self.name) if pred(k)])

    @staticmethod
    def _kb(k: Any) -> bytes | None:
        try:
            return pickle.dumps(k, protocol=pickle.HIGHEST_PROTOCOL)
        except Exception:  # noqa: BLE001 — clé non sérialisable (fonction…) : mémoire seulement
            return None

    def get_fixed(self, k: Any, compute: Callable[[], Any]) -> Any:
        """Sans la version de la bibliothèque : pour un calcul qui ne dépend que d'un match (la clé porte alors
        l'identité de son analyse, ex. date d'import), et qui survit donc aux imports des autres démos."""
        with self._lock:
            if k in self._d:
                self._d.move_to_end(k)
                return self._d[k]
        kb = self._kb(k) if _disk is not None else None
        val = _disk.get(self.name, kb) if kb is not None else None
        if val is None:
            val = compute()
            if kb is not None:
                _disk.put(self.name, kb, val)
        with self._lock:
            self._d[k] = val
            while len(self._d) > self.size:
                self._d.popitem(last=False)
        return val
