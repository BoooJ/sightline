# backend/app/stats/places.py
"""Nommer une position sur la carte : callout placé à la main par l'équipe, sinon zone de callout des joueurs
(Window, Tetris…), sinon lieu du jeu le plus proche (centres tirés des morts de la bibliothèque)."""
from __future__ import annotations

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.maps.callouts import callout_at
from app.maps.registry import MapMeta, level_for_z
from app.stats.timings import ZONE_R, place_centers
from app.storage.models import Callout

CUSTOM_R = 300.0

Center = tuple[str, tuple[float, float, float], float]


def place_markers(session: Session, meta: MapMeta) -> list[Center]:
    """Repères (nom, centre, rayon) : callouts placés à la main d'abord, puis lieux du jeu."""
    out: list[Center] = []
    for c in session.scalars(select(Callout).where(Callout.map_name == meta.name, Callout.x.is_not(None))):
        out.append((c.place, (c.x, c.y, c.z), CUSTOM_R))
    out += [(p, c, ZONE_R) for p, c in place_centers(session, meta).items()]
    return out


def place_of(meta: MapMeta, centers: list[Center], x: float, y: float, z: float) -> str | None:
    lvl = level_for_z(meta, z) if len(meta.levels) > 1 else None
    for name, c, r in centers:
        if r == CUSTOM_R and (lvl is None or level_for_z(meta, c[2]) == lvl) and float(np.hypot(c[0] - x, c[1] - y)) <= r:
            return name
    zone = callout_at(meta, x, y, z)
    if zone:
        return zone
    best, bd = None, None
    for name, c, r in centers:
        if lvl is not None and level_for_z(meta, c[2]) != lvl:
            continue
        d = float(np.hypot(c[0] - x, c[1] - y))
        if d <= r and (bd is None or d < bd):
            best, bd = name, d
    return best
