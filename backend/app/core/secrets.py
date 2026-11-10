"""Secrets saisis dans l'application (clés d'API) : data/secrets.json, lisible par le seul propriétaire du fichier."""
from __future__ import annotations

import json
import os
from pathlib import Path


def secrets_path(data_dir: Path) -> Path:
    return data_dir / "secrets.json"


def read_secrets(data_dir: Path) -> dict:
    try:
        return json.loads(secrets_path(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_secrets(data_dir: Path, sec: dict) -> None:
    p = secrets_path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(sec), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(p)
