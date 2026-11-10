# backend/app/api/maps.py
import re

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.maps.callouts import _area, edited, reset_team_zones, save_team_zones, zones
from app.maps.registry import MapMeta
from app.stats.cache import LibraryCache
from app.storage.models import Match, Strat

router = APIRouter(prefix="/api/maps", tags=["maps"])
MAX_ZONES, MAX_POINTS = 300, 100
_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


@router.get("")
def maps(request: Request, all: bool = False, db: Session = Depends(get_session)):
    """Cartes du pool compétitif actuel, plus les cartes sorties du pool pour lesquelles la bibliothèque a des matchs
    ou des stratégies (les anciennes démos restent consultables). `all=true` : toutes les cartes connues."""
    used = set(db.scalars(select(Match.map_name).distinct())) | set(db.scalars(select(Strat.map_name).distinct()))
    out = [m for m in request.app.state.maps.values() if all or m.active_duty or m.name in used]
    out.sort(key=lambda m: (not m.active_duty, m.display_name.lower()))
    return [m.to_dict() for m in out]


@router.get("/{name}")
def map_meta(name: str, request: Request):
    m = request.app.state.maps.get(name)
    if m is None:
        raise HTTPException(404, "Carte inconnue")
    return m.to_dict()


@router.get("/{name}/callouts")
def map_callouts(name: str, request: Request):
    """Zones des callouts des joueurs (nom, polygone en coordonnées du jeu, niveau), pour les afficher sur le radar."""
    if name not in request.app.state.maps:
        raise HTTPException(404, "Carte inconnue")
    return [{"name": z.name, "level": z.level, "poly": [[round(x), round(y)] for x, y in z.poly], "color": z.color}
            for z in zones(name)]


def _meta(request: Request, name: str) -> MapMeta:
    m = request.app.state.maps.get(name)
    if m is None:
        raise HTTPException(404, "Carte inconnue")
    return m


def _zones_out(name: str) -> dict:
    zs = sorted(zones(name), key=lambda z: z.name.lower())
    return {"map": name, "edited": edited(name), "zones": [
        {"name": z.name, "level": z.level, "poly": [[round(x), round(y)] for x, y in z.poly], "color": z.color} for z in zs]}


def _clean_zones(meta: MapMeta, body: dict) -> list[dict]:
    items = body.get("zones")
    if not isinstance(items, list) or len(items) > MAX_ZONES:
        raise HTTPException(400, f"{MAX_ZONES} zones au plus")
    levels = {lv.name for lv in meta.levels} if len(meta.levels) > 1 else set()
    out = []
    for z in items:
        if not isinstance(z, dict):
            raise HTTPException(400, "Zone invalide")
        name = str(z.get("name") or "").strip()[:40]
        if not name:
            raise HTTPException(400, "Chaque zone a besoin d'un nom")
        level = z.get("level") or None
        if level is not None and level not in levels:
            raise HTTPException(400, f"Zone « {name} » : niveau inconnu")
        poly = z.get("poly")
        if not isinstance(poly, list) or not 3 <= len(poly) <= MAX_POINTS or not all(
                isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) and abs(v) < 100_000 for v in p) for p in poly):
            raise HTTPException(400, f"Zone « {name} » : 3 à {MAX_POINTS} points")
        pts = [[round(float(x)), round(float(y))] for x, y in poly]
        if _area([tuple(p) for p in pts]) < 1:
            raise HTTPException(400, f"Zone « {name} » : surface nulle")
        color = z.get("color") or None
        if color is not None and not _COLOR.fullmatch(str(color)):
            raise HTTPException(400, f"Zone « {name} » : couleur invalide")
        out.append({"name": name, "level": level, "poly": pts, **({"color": str(color).lower()} if color else {})})
    return out


@router.get("/{name}/zones")
def team_zones(name: str, request: Request):
    """Zones de callouts de la carte pour la page Callouts : celles de l'équipe si elle les a redessinées."""
    _meta(request, name)
    return _zones_out(name)


@router.put("/{name}/zones")
def put_team_zones(name: str, request: Request, body: dict = Body(...)):
    """Zones redessinées par l'équipe : elles nomment désormais les positions partout (kills, analyses, scouting)."""
    items = _clean_zones(_meta(request, name), body)
    save_team_zones(name, items)
    LibraryCache.clear_all()  # analyses et histoires déjà calculées portent les anciens noms
    return _zones_out(name)


@router.delete("/{name}/zones")
def reset_zones(name: str, request: Request):
    """Retour aux zones de Sightline."""
    _meta(request, name)
    reset_team_zones(name)
    LibraryCache.clear_all()
    return _zones_out(name)
