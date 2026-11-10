# backend/app/modules/__init__.py
"""Point d'extension. Chaque module (stats, grenades, heatmaps…) est un package app.modules.<nom>
exposant register(app, registry). Il est activé en l'ajoutant à `modules` dans config.toml."""
from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass, field

from fastapi import FastAPI

from app.ingest.service import PostImportHook

log = logging.getLogger(__name__)


@dataclass
class ModuleRegistry:
    post_import_hooks: list[PostImportHook] = field(default_factory=list)
    loaded: list[str] = field(default_factory=list)


def load_modules(app: FastAPI, names: list[str], registry: ModuleRegistry) -> None:
    for name in names:
        try:
            mod = importlib.import_module(f"app.modules.{name}")
            mod.register(app, registry)
            registry.loaded.append(name)
        except Exception:  # un module cassé ne doit pas empêcher l'app de démarrer
            log.exception("Module %s non chargé", name)
