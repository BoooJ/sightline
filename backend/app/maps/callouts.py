# backend/app/maps/callouts.py
"""Callouts des joueurs (Window, Tetris, Firebox, Ninja…) sous forme de zones en coordonnées du jeu.

Fichiers : maps/callouts/<carte>.json (noms et polygones, recalés sur les radars Valve ; sources et méthode dans
research_notes/Callouts CS2 par carte). Les noms de lieux écrits par le jeu dans les démos sont plus larges et parfois
différents des noms en usage (« SnipersNest » pour Window, « Shop » pour Market) : une position est d'abord nommée par
la zone de callout qui la contient. Zones imbriquées : la plus petite (la plus précise) l'emporte."""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path

from app.core.config import ROOT
from app.maps.registry import MapMeta, level_for_z

CALLOUTS_DIR = ROOT / "maps" / "callouts"
# zones redessinées par l'équipe (page Callouts) : un fichier par carte, même format, dans le dossier de données ;
# il remplace celui de Sightline tant qu'il existe (« Réinitialiser » le supprime)
_team_dir: Path | None = None


@dataclass(frozen=True)
class Zone:
    name: str
    level: str | None
    poly: tuple[tuple[float, float], ...]
    bbox: tuple[float, float, float, float]
    area: float
    color: str | None = None


_cache: dict[str, list[Zone]] = {}
_lock = threading.Lock()


def configure(team_dir: Path | None) -> None:
    """Au démarrage : dossier des zones de l'équipe (dans le dossier de données)."""
    global _team_dir
    with _lock:
        _team_dir = team_dir
        _cache.clear()


def _area(poly) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]))) / 2


def team_file(map_name: str) -> Path | None:
    return _team_dir / f"{map_name}.json" if _team_dir is not None else None


def edited(map_name: str) -> bool:
    p = team_file(map_name)
    return p is not None and p.exists()


def zones(map_name: str, directory: Path = CALLOUTS_DIR) -> list[Zone]:
    with _lock:
        if map_name in _cache:
            return _cache[map_name]
    out: list[Zone] = []
    p = team_file(map_name) if directory == CALLOUTS_DIR and edited(map_name) else directory / f"{map_name}.json"
    if p is not None and p.exists():
        for c in json.loads(p.read_text(encoding="utf-8")).get("callouts", []):
            poly = [(float(x), float(y)) for x, y in c["poly"]]
            if len(poly) < 3:
                continue
            xs, ys = [x for x, _ in poly], [y for _, y in poly]
            out.append(Zone(c["name"], c.get("level"), tuple(poly), (min(xs), min(ys), max(xs), max(ys)), _area(poly),
                            c.get("color")))
        out.sort(key=lambda z: z.area)  # la plus petite zone qui contient le point gagne
    with _lock:
        _cache[map_name] = out
    return out


def save_team_zones(map_name: str, items: list[dict]) -> None:
    """Zones de l'équipe pour cette carte (déjà validées : nom, niveau, polygone en coordonnées du jeu, couleur)."""
    p = team_file(map_name)
    if p is None:
        raise RuntimeError("dossier des zones de l'équipe non configuré")
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"map": map_name, "source": "équipe (page Callouts)", "callouts": items}, ensure_ascii=False),
                   encoding="utf-8")
    tmp.replace(p)
    with _lock:
        _cache.pop(map_name, None)


def reset_team_zones(map_name: str) -> None:
    p = team_file(map_name)
    if p is not None and p.exists():
        p.unlink()
    with _lock:
        _cache.pop(map_name, None)


def _inside(poly, x: float, y: float) -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def callout_at(meta: MapMeta, x: float, y: float, z: float) -> str | None:
    """Nom du callout qui contient la position, ou None (carte sans données, ou position hors des zones)."""
    zs = zones(meta.name)
    if not zs:
        return None
    lvl = level_for_z(meta, z) if len(meta.levels) > 1 else None
    for zn in zs:
        if zn.level and lvl and zn.level != lvl:
            continue
        x0, y0, x1, y1 = zn.bbox
        if x0 <= x <= x1 and y0 <= y <= y1 and _inside(zn.poly, x, y):
            return zn.name
    return None
