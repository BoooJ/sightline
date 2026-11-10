# backend/app/api/annotations.py
import json

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.storage.models import Annotation, Match, Round

router = APIRouter(tags=["annotations"])
TOOLS = {"pen", "line", "arrow", "circle", "rect", "text"}
MAX_SHAPES, MAX_POINTS = 500, 2000


def _round(db: Session, round_id: int) -> Round:
    r = db.get(Round, round_id)
    if r is None:
        raise HTTPException(404, "Round introuvable")
    return r


def _find(db: Session, r: Round) -> Annotation | None:
    return db.scalar(select(Annotation).where(Annotation.demo_id == r.match.demo_id, Annotation.round_number == r.number))


def _clean(data: dict) -> dict:
    shapes = data.get("shapes", [])
    if not isinstance(shapes, list) or len(shapes) > MAX_SHAPES:
        raise HTTPException(400, "Trop de dessins")
    out = []
    for s in shapes:
        if not isinstance(s, dict) or s.get("tool") not in TOOLS:
            raise HTTPException(400, "Dessin invalide")
        pts = s.get("points", [])
        if not isinstance(pts, list) or not pts or len(pts) > MAX_POINTS \
                or not all(isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) for v in p) for p in pts):
            raise HTTPException(400, "Points invalides")
        out.append({
            "id": str(s.get("id", ""))[:40], "tool": s["tool"], "color": str(s.get("color", "#2ee6a6"))[:32],
            "width": max(1, min(12, float(s.get("width", 3)))), "level": str(s.get("level", ""))[:32],
            "points": [[round(float(x), 1), round(float(y), 1)] for x, y in pts], "text": str(s.get("text", ""))[:200],
            "from_tick": s.get("from_tick") if isinstance(s.get("from_tick"), int) else None,
            "to_tick": s.get("to_tick") if isinstance(s.get("to_tick"), int) else None,
        })
    return {"shapes": out, "note": str(data.get("note", ""))[:5000]}


@router.get("/api/rounds/{round_id}/annotations")
def get_annotations(round_id: int, db: Session = Depends(get_session)):
    a = _find(db, _round(db, round_id))
    return json.loads(a.data) if a else {"shapes": [], "note": ""}


@router.put("/api/rounds/{round_id}/annotations")
def put_annotations(round_id: int, body: dict = Body(...), db: Session = Depends(get_session)):
    r = _round(db, round_id)
    data = _clean(body)
    a = _find(db, r)
    if not data["shapes"] and not data["note"].strip():
        if a:
            db.delete(a)
            db.commit()
        return data
    if a is None:
        a = Annotation(demo_id=r.match.demo_id, round_number=r.number)
        db.add(a)
    a.data = json.dumps(data, ensure_ascii=False)
    a.updated_at = func.now()
    db.commit()
    return data


@router.get("/api/matches/{match_id}/annotations")
def annotated_rounds(match_id: int, db: Session = Depends(get_session)):
    """Numéros des rounds annotés du match (repère dans la frise des rounds)."""
    m = db.get(Match, match_id)
    if m is None:
        raise HTTPException(404, "Match introuvable")
    return sorted(db.scalars(select(Annotation.round_number).where(Annotation.demo_id == m.demo_id)))
