# backend/app/maps/registry.py
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

RADAR_SIZE = 1024


@dataclass
class MapLevel:
    name: str
    image: str
    z_min: float
    z_max: float


@dataclass
class MapMeta:
    name: str
    display_name: str
    pos_x: float
    pos_y: float
    scale: float
    image: str
    levels: list[MapLevel]
    bomb_a: tuple[float, float] | None = None
    bomb_b: tuple[float, float] | None = None
    active_duty: bool = True  # dans le pool compétitif actuel (veto, sélecteurs)

    def to_dict(self) -> dict:
        return asdict(self)


def load_maps(maps_dir: Path) -> dict[str, MapMeta]:
    out: dict[str, MapMeta] = {}
    for p in sorted(Path(maps_dir).glob("*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        d["levels"] = [MapLevel(**lvl) for lvl in d["levels"]]
        d["bomb_a"] = tuple(d["bomb_a"]) if d.get("bomb_a") else None
        d["bomb_b"] = tuple(d["bomb_b"]) if d.get("bomb_b") else None
        out[d["name"]] = MapMeta(**d)
    return out


def world_to_radar(m: MapMeta, x: float, y: float) -> tuple[float, float]:
    return ((x - m.pos_x) / m.scale, (m.pos_y - y) / m.scale)


def level_for_z(m: MapMeta, z: float) -> str:
    for lvl in m.levels:
        if lvl.z_min <= z < lvl.z_max:
            return lvl.name
    return m.levels[0].name


def resolve_site(m: MapMeta, x: float, y: float) -> str | None:
    """Site de bombe le plus proche d'une position monde (A ou B), d'après l'overview."""
    best, best_d = None, float("inf")
    for name, rel in (("A", m.bomb_a), ("B", m.bomb_b)):
        if rel is None:
            continue
        bx, by = m.pos_x + rel[0] * RADAR_SIZE * m.scale, m.pos_y - rel[1] * RADAR_SIZE * m.scale
        d = (bx - x) ** 2 + (by - y) ** 2
        if d < best_d:
            best, best_d = name, d
    return best
