# backend/app/api/matches.py
import json
from collections import Counter
from datetime import date

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session, lib_filters
from app.stats.analysis import match_analysis
from app.stats.cache import LibraryCache
from app.stats.compute import ECONS, match_stats
from app.storage.labels import LibraryFilters, labels_of
from app.storage.models import Match, MatchLabel
from app.storage.repository import get_match_detail, list_matches

router = APIRouter(prefix="/api/matches", tags=["matches"])


@router.get("")
def matches(map: str | None = None, q: str | None = None, lib: LibraryFilters = Depends(lib_filters),
            db: Session = Depends(get_session)):
    return list_matches(db, map_name=map, q=q, lib=lib)


@router.get("/facets")
def facets(db: Session = Depends(get_session)):
    """Dossiers, événements et étiquettes de la bibliothèque, avec leur nombre de matchs."""
    folders, events, tags = Counter(), Counter(), Counter()
    for m in db.scalars(select(Match)):
        lab = labels_of(m)
        if lab["folder"]:
            folders[lab["folder"]] += 1
        if lab["event"]:
            events[lab["event"]] += 1
        tags.update(lab["tags"])
    as_list = lambda c: [{"name": k, "count": v} for k, v in sorted(c.items(), key=lambda x: x[0].lower())]  # noqa: E731
    return {"folders": as_list(folders), "events": as_list(events), "tags": as_list(tags)}


@router.post("/labels/bulk")
def set_labels_bulk(body: dict = Body(...), db: Session = Depends(get_session)):
    """Organise plusieurs matchs d'un coup : dossier et/ou événement remplacés, étiquettes ajoutées ou retirées."""
    ids = [int(x) for x in body.get("ids", [])]
    if not ids:
        raise HTTPException(400, "Aucun match")
    add = {str(t).strip()[:40] for t in body.get("tags_add", []) if str(t).strip()}
    rem = {str(t).strip() for t in body.get("tags_remove", [])}
    done = 0
    for m in db.scalars(select(Match).where(Match.id.in_(ids))):
        lab = db.get(MatchLabel, m.demo_id) or MatchLabel(demo_id=m.demo_id, folder="", event="", tags="[]")
        if "folder" in body:
            lab.folder = str(body["folder"] or "").strip()[:128]
        if "event" in body:
            lab.event = str(body["event"] or "").strip()[:128]
        if add or rem:
            lab.tags = json.dumps(sorted((set(json.loads(lab.tags or "[]")) | add) - rem)[:20], ensure_ascii=False)
        db.merge(lab)
        done += 1
    db.commit()
    return {"updated": done}


@router.patch("/{match_id}/labels")
def set_labels(match_id: int, body: dict = Body(...), db: Session = Depends(get_session)):
    m = db.get(Match, match_id)
    if m is None:
        raise HTTPException(404, "Match introuvable")
    lab = db.get(MatchLabel, m.demo_id) or MatchLabel(demo_id=m.demo_id, folder="", event="", tags="[]")
    if "folder" in body:
        lab.folder = str(body["folder"] or "").strip()[:128]
    if "event" in body:
        lab.event = str(body["event"] or "").strip()[:128]
    if "tags" in body:
        tags = body["tags"] if isinstance(body["tags"], list) else []
        lab.tags = json.dumps(sorted({str(t).strip()[:40] for t in tags if str(t).strip()})[:20], ensure_ascii=False)
    if "played_on" in body:
        try:
            lab.played_on = date.fromisoformat(body["played_on"]) if body["played_on"] else None
        except ValueError:
            raise HTTPException(400, "Date invalide (AAAA-MM-JJ)")
    db.merge(lab)
    db.commit()
    db.refresh(m)
    return labels_of(m)


@router.get("/{match_id}")
def match(match_id: int, db: Session = Depends(get_session)):
    d = get_match_detail(db, match_id)
    if d is None:
        raise HTTPException(404, "Match introuvable")
    return d


@router.get("/{match_id}/stats")
def stats(match_id: int, side: str | None = None, econ: str | None = None, opp_econ: str | None = None,
          db: Session = Depends(get_session)):
    side = side.upper() if side else None
    if side not in (None, "CT", "T"):
        raise HTTPException(400, "side doit valoir CT ou T")
    if econ not in (None, *ECONS) or opp_econ not in (None, "buy", "eco"):
        raise HTTPException(400, "econ invalide")
    d = match_stats(db, match_id, side, econ, opp_econ)
    if d is None:
        raise HTTPException(404, "Match introuvable")
    return d


_analysis_cache = LibraryCache(48)
_summary_cache = LibraryCache(5000)  # résumé par joueur (léger), pour les agrégats de carrière


def _stamp(db: Session, match_id: int):
    m = db.get(Match, match_id)
    return (match_id, m.demo.imported_at if m and m.demo else None) if m else None


def analysis_for(db: Session, match_id: int) -> dict | None:
    stamp = _stamp(db, match_id)
    if stamp is None:
        return None
    return _analysis_cache.get_fixed(("analysis",) + stamp, lambda: match_analysis(db, match_id))


def forget_match(match_id: int) -> None:
    for c in (_analysis_cache, _summary_cache):
        c.drop(lambda k: len(k) > 1 and k[1] == match_id)


def players_summary_for(db: Session, match_id: int) -> dict | None:
    """Partie « joueurs » de l'analyse, gardée longtemps : les agrégats de carrière ne recalculent que les nouveaux
    matchs après un import."""
    stamp = _stamp(db, match_id)
    if stamp is None:
        return None

    def compute():
        a = analysis_for(db, match_id)
        return {"players": a["players"]} if a else None
    return _summary_cache.get_fixed(("summary",) + stamp, compute)


@router.get("/{match_id}/analysis")
def analysis(match_id: int, db: Session = Depends(get_session)):
    """Probabilité de victoire, impact, raisons de mort, avantages perdus et audit économique du match."""
    d = analysis_for(db, match_id)
    if d is None:
        raise HTTPException(404, "Match introuvable")
    return d
