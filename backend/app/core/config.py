# backend/app/core/config.py
"""Configuration de l'application, lue depuis config.toml (racine du projet) ou SKYBOX_CONFIG."""
from __future__ import annotations

import os
import tomllib
from pathlib import Path

import tomli_w
from pydantic import BaseModel, PrivateAttr

ROOT = Path(__file__).resolve().parents[3]  # dossier skybox_cs/


class Settings(BaseModel):
    data_dir: Path = ROOT / "data"
    maps_dir: Path = ROOT / "maps"
    frontend_dist: Path = ROOT / "frontend" / "dist"
    mobile_dist: Path = ROOT / "mobile" / "dist"  # app mobile, version web (servie sous /app/)
    demo_folders: list[Path] = []
    sample_rate: int = 32  # images/s gardées pour le replay (vue du joueur fluide) ; ré-analyser après changement
    max_parallel_imports: int = 2
    host: str = "127.0.0.1"
    port: int = 8000
    modules: list[str] = []
    trade_window_s: float = 5.0
    eco_max: int = 5000
    semi_max: int = 10000
    force_max: int = 20000
    warm_caches: bool = True
    discord_webhook: str = ""  # alertes d'équipe (match prêt, commentaires, rapports) vers un salon Discord
    notify_discord: bool = True
    public_url: str = ""  # adresse publique du site, pour les liens dans Discord (ex. https://demos.example.org)  # précalcul des rôles et de la carrière au démarrage et après chaque import

    _config_path: Path | None = PrivateAttr(default=None)

    @property
    def config_path(self) -> Path | None:
        return self._config_path

    @property
    def db_url(self) -> str:
        return f"sqlite:///{(self.data_dir / 'skybox.db').as_posix()}"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"


def default_config_path() -> Path:
    return Path(os.environ.get("SKYBOX_CONFIG", ROOT / "config.toml"))


def load_settings(path: Path | None = None) -> Settings:
    path = path or default_config_path()
    data = tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if os.environ.get("SKYBOX_DATA_DIR"):
        data["data_dir"] = os.environ["SKYBOX_DATA_DIR"]
    # serveur à mémoire limitée : une analyse de grosse démo monte à ~1,4 Go, deux en parallèle dépasseraient 2 Go
    if os.environ.get("SKYBOX_MAX_PARALLEL_IMPORTS"):
        data["max_parallel_imports"] = int(os.environ["SKYBOX_MAX_PARALLEL_IMPORTS"])
    s = Settings(**data)
    s._config_path = path
    return s


def save_settings(s: Settings, path: Path) -> None:
    data = s.model_dump(mode="json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(tomli_w.dumps(data), encoding="utf-8")
