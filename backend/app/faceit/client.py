# backend/app/faceit/client.py
"""Client de l'API Data de FACEIT (v4) : clé, cache disque, nouvelles tentatives.

Un match terminé ne change plus : sa fiche et ses stats sont gardées indéfiniment. Le reste (équipe, historiques,
profils) l'est une heure, ce qui suffit à préparer un match sans épuiser le quota de l'API."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

import httpx

from app.core.secrets import read_secrets, write_secrets

BASE = "https://open.faceit.com/data/v4"
ENV_KEYS = ("SKYBOX_FACEIT_API_KEY", "FACEIT_API_KEY")
HOUR = 3600
RETRIES = 4


class FaceitError(Exception):
    """Erreur présentée telle quelle à l'utilisateur (avec le code HTTP à renvoyer)."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def api_key(data_dir: Path) -> tuple[str | None, str | None]:
    """(clé, origine) : la variable d'environnement l'emporte sur la clé saisie dans l'app."""
    for env in ENV_KEYS:
        if os.environ.get(env):
            return os.environ[env], "env"
    key = read_secrets(data_dir).get("faceit_api_key")
    return (key, "app") if key else (None, None)


def save_key(data_dir: Path, key: str | None) -> None:
    sec = read_secrets(data_dir)
    if key:
        sec["faceit_api_key"] = key
    else:
        sec.pop("faceit_api_key", None)
    write_secrets(data_dir, sec)


class FaceitClient:
    def __init__(self, key: str, cache_dir: Path, transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.cache_dir = cache_dir
        self.sleep = sleep
        self.http = httpx.Client(base_url=BASE, transport=transport, timeout=20,
                                 headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})

    def close(self) -> None:
        self.http.close()

    def _cache_file(self, path: str, params: dict | None) -> Path:
        raw = path + "?" + json.dumps(params or {}, sort_keys=True)
        return self.cache_dir / f"{hashlib.sha1(raw.encode()).hexdigest()}.json"

    def get(self, path: str, params: dict | None = None, ttl: float | None = HOUR) -> dict:
        """GET mis en cache (`ttl=None` : pour toujours). 404 → FaceitError(…, 404)."""
        f = self._cache_file(path, params)
        try:
            entry = json.loads(f.read_text(encoding="utf-8"))
            age = time.time() - entry["t"]
            if entry.get("missing"):  # absent (404) : redemandé au bout d'une heure au plus
                if age < min(HOUR, HOUR if ttl is None else ttl):
                    raise FaceitError("Introuvable sur FACEIT.", 404)
            elif ttl is None or age < ttl:
                return entry["data"]
        except (OSError, ValueError, KeyError):
            pass
        try:
            data = self._fetch(path, params)
        except FaceitError as e:
            if e.status == 404:
                self._store(f, {"t": time.time(), "missing": True})
            raise
        self._store(f, {"t": time.time(), "data": data})
        return data

    @staticmethod
    def _store(f: Path, entry: dict) -> None:
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
            tmp.write_text(json.dumps(entry), encoding="utf-8")
            tmp.replace(f)
        except OSError:
            pass

    def _fetch(self, path: str, params: dict | None) -> dict:
        delay = 1.0
        for attempt in range(RETRIES + 1):
            try:
                r = self.http.get(path, params=params)
            except httpx.HTTPError as e:
                if attempt == RETRIES:
                    raise FaceitError(f"FACEIT injoignable : {e}") from e
                self.sleep(delay)
                delay *= 2
                continue
            if r.status_code == 429 or r.status_code >= 500:
                if attempt == RETRIES:
                    raise FaceitError("FACEIT est saturé (trop de requêtes) : réessayez dans une minute.", 503)
                retry_after = r.headers.get("Retry-After", "")
                self.sleep(float(retry_after) if retry_after.isdigit() else delay)
                delay *= 2
                continue
            if r.status_code in (401, 403):
                raise FaceitError("Clé d'API FACEIT refusée : vérifiez-la sur developers.faceit.com.", 502)
            if r.status_code == 404:
                raise FaceitError("Introuvable sur FACEIT.", 404)
            if r.status_code >= 400:
                raise FaceitError(f"FACEIT a répondu {r.status_code}.")
            return r.json()
        raise FaceitError("FACEIT injoignable.")  # pragma: no cover
