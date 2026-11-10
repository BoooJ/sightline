# backend/app/api/callouts.py
"""Callouts personnalisés : nom d'un lieu de carte dans le vocabulaire de l'équipe (« Hut » → « Cabane »)."""
import secrets

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func, select, union_all
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.storage.models import Callout, Kill, Match, Round

router = APIRouter(prefix="/api/callouts", tags=["callouts"])


@router.get("")
def callouts(map: str, db: Session = Depends(get_session)):
    """Lieux de la carte vus dans les démos (avec leur nombre de kills) et nom personnalisé de chacun."""
    on_map = select(Round.id).join(Match, Match.id == Round.match_id).where(Match.map_name == map)
    places = union_all(
        select(Kill.victim_place.label("p")).where(Kill.round_id.in_(on_map), Kill.victim_place.is_not(None)),
        select(Kill.attacker_place.label("p")).where(Kill.round_id.in_(on_map), Kill.attacker_place.is_not(None)),
    ).subquery()
    counts = dict(db.execute(select(places.c.p, func.count()).group_by(places.c.p)).all())
    # position représentative : centre des morts dans ce lieu (pour placer l'étiquette sur le radar)
    centers = {p: (x, y, z) for p, x, y, z in db.execute(
        select(Kill.victim_place, func.avg(Kill.victim_x), func.avg(Kill.victim_y), func.avg(Kill.victim_z))
        .where(Kill.round_id.in_(on_map), Kill.victim_place.is_not(None)).group_by(Kill.victim_place))}
    rows_db = list(db.scalars(select(Callout).where(Callout.map_name == map)))
    labels = {c.place: c.label for c in rows_db if c.x is None}
    custom = [{"id": c.id, "label": c.label, "pos": [round(c.x), round(c.y), round(c.z or 0)]} for c in rows_db if c.x is not None]
    rows = [{"place": p, "label": labels.get(p), "count": counts.get(p, 0),
             "pos": [round(v) for v in centers[p]] if p in centers else None} for p in set(counts) | set(labels)]
    rows.sort(key=lambda r: (-r["count"], r["place"].lower()))
    return {"map": map, "places": rows, "labels": labels, "custom": custom}


@router.put("")
def set_callout(body: dict = Body(...), db: Session = Depends(get_session)):
    map_name, place = str(body.get("map", "")).strip(), str(body.get("place", "")).strip()
    label = str(body.get("label") or "").strip()[:64]
    if not map_name or not place:
        raise HTTPException(400, "Carte et lieu requis")
    row = db.scalar(select(Callout).where(Callout.map_name == map_name, Callout.place == place))
    if not label:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(Callout(map_name=map_name, place=place[:64], label=label))
    else:
        row.label = label
    db.commit()
    return {"map": map_name, "place": place, "label": label or None}


def _pos(v) -> tuple[float, float, float]:
    if not isinstance(v, list) or len(v) != 3 or not all(isinstance(a, (int, float)) for a in v):
        raise HTTPException(400, "Position invalide")
    return float(v[0]), float(v[1]), float(v[2])


@router.post("/custom")
def add_custom(body: dict = Body(...), db: Session = Depends(get_session)):
    """Callout placé à la main sur le radar (ex. « Banane bas », « Coin ninja »)."""
    map_name, label = str(body.get("map", "")).strip(), str(body.get("label") or "").strip()[:64]
    if not map_name or not label:
        raise HTTPException(400, "Carte et nom requis")
    x, y, z = _pos(body.get("pos"))
    c = Callout(map_name=map_name, place=f"@{secrets.token_hex(6)}", label=label, x=x, y=y, z=z)
    db.add(c)
    db.commit()
    return {"id": c.id, "label": c.label, "pos": [round(x), round(y), round(z)]}


@router.patch("/custom/{callout_id}")
def update_custom(callout_id: int, body: dict = Body(...), db: Session = Depends(get_session)):
    c = db.get(Callout, callout_id)
    if c is None or c.x is None:
        raise HTTPException(404, "Callout introuvable")
    if "label" in body:
        label = str(body.get("label") or "").strip()[:64]
        if not label:
            raise HTTPException(400, "Nom requis")
        c.label = label
    if "pos" in body:
        c.x, c.y, c.z = _pos(body["pos"])
    db.commit()
    return {"id": c.id, "label": c.label, "pos": [round(c.x), round(c.y), round(c.z or 0)]}


@router.delete("/custom/{callout_id}")
def delete_custom(callout_id: int, db: Session = Depends(get_session)):
    c = db.get(Callout, callout_id)
    if c is None or c.x is None:
        raise HTTPException(404, "Callout introuvable")
    db.delete(c)
    db.commit()
    return {"ok": True}
