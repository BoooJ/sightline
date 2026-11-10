# backend/app/modules/replay3d/__init__.py
"""Module « replay3d » : cartes 3D du replay (spec docs/superpowers/specs/2026-10-25-replay-3d-design.md) et autres
fichiers 3D (bras et armes de la vue du joueur, spec du 29/10/2026 dans docs/superpowers/specs). Activé par
`modules = ["replay3d"]` dans config.toml ; sans lui, /api/maps3d et /api/assets3d n'existent pas et le replay reste
en 2D."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import FastAPI

from app.modules.replay3d import assets, store
from app.modules.replay3d.api import assets_router, router

if TYPE_CHECKING:
    from app.modules import ModuleRegistry

log = logging.getLogger(__name__)


def register(app: FastAPI, registry: ModuleRegistry) -> None:
    # routes d'abord : un nettoyage raté (droits, fichier verrouillé) ne doit pas couper /api/maps3d ni /api/assets3d
    app.include_router(router)
    app.include_router(assets_router)
    for clean in (store.clean_stale, assets.clean_stale):
        try:
            clean(app.state.settings.data_dir)
        except Exception:  # nettoyage des envois abandonnés : un échec ne coupe pas le module
            log.exception("Nettoyage des envois 3D au chargement échoué")
