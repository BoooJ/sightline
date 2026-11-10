# backend/app/api/debrief.py
"""Débrief de match (histoire du match, 3 problèmes, 5 rounds à revoir, conclusions écrites) et axes de travail
d'équipe suivis match après match."""
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.api.matches import analysis_for
from app.auth.core import require_user
from app.maps.registry import MapMeta
from app.stats.cache import LibraryCache
from app.stats.debrief import METRICS, goal_progress, match_debrief, team_match_metrics
from app.stats.playbook import match_t_rounds
from app.storage.models import Match, MatchDebrief, Team, TeamGoal, User

router = APIRouter(tags=["debrief"])
_metrics_cache = LibraryCache(4000, "team-match-metrics")
TEXT_MAX = 4000


def metrics_for(db: Session, match_id: int, team_id: int, maps: dict[str, MapMeta]) -> dict:
    """`maps` est obligatoire : un calcul fait sans les cartes (sans prise du site) ne doit jamais entrer en cache."""
    m = db.get(Match, match_id)
    if m is None:
        return {}
    stamp = (match_id, m.demo.imported_at if m.demo else None, team_id)

    def compute():
        a = analysis_for(db, match_id) or {}
        rows = match_t_rounds(db, maps, match_id, team_id) if m.map_name in maps else None
        return team_match_metrics(db, match_id, team_id, a, t_rounds=rows)
    return _metrics_cache.get_fixed(("tm",) + stamp, compute)


def catalog() -> list[dict]:
    return [{"key": k, "label": v["label"], "better": v["better"], "unit": v["unit"], "drill": v.get("drill")} for k, v in METRICS.items()]


def _goal_dict(db: Session, g: TeamGoal, maps: dict[str, MapMeta], with_progress: bool = True) -> dict:
    d = {"id": g.id, "team_id": g.team_id, "metric": g.metric, "metric_label": METRICS.get(g.metric, {}).get("label", g.metric),
         "better": METRICS.get(g.metric, {}).get("better", "up"), "title": g.title, "note": g.note, "target": g.target,
         "source_match_id": g.source_match_id, "created_at": g.created_at.isoformat() if g.created_at else None,
         "archived": g.archived_at is not None}
    if with_progress:
        d.update(goal_progress(db, g, lambda mid: metrics_for(db, mid, g.team_id, maps)))
    return d


def _match_team(db: Session, match_id: int, team: int | None) -> tuple[Match, int]:
    m = db.get(Match, match_id)
    if m is None:
        raise HTTPException(404, "Match introuvable")
    tid = team or m.team_a_id
    if tid not in (m.team_a_id, m.team_b_id):
        raise HTTPException(400, "Cette équipe n'a pas joué ce match")
    return m, tid


@router.get("/api/matches/{match_id}/debrief")
def get_debrief(request: Request, match_id: int, team: int | None = None, db: Session = Depends(get_session)):
    m, tid = _match_team(db, match_id, team)
    maps = request.app.state.maps
    d = match_debrief(db, m, tid, lambda mid: metrics_for(db, mid, tid, maps))
    note = db.get(MatchDebrief, (match_id, tid))
    d["notes"] = {"worked": note.worked if note else "", "change": note.change if note else "", "actions": note.actions if note else "",
                  "updated_at": note.updated_at.isoformat() if note and note.updated_at else None}
    goals = db.scalars(select(TeamGoal).where(TeamGoal.team_id == tid, TeamGoal.archived_at.is_(None)).order_by(TeamGoal.id))
    d["goals"] = [{**_goal_dict(db, g, maps, with_progress=False), "here": d["metrics"].get(g.metric)} for g in goals]
    d["teams"] = [{"id": t.id, "name": t.name} for t in (m.team_a, m.team_b)]
    d["catalog"] = catalog()
    return d


@router.put("/api/matches/{match_id}/debrief")
def save_debrief(match_id: int, team: int | None = None, body: dict = Body(...), user: User | None = Depends(require_user),
                 db: Session = Depends(get_session)):
    _, tid = _match_team(db, match_id, team)
    note = db.get(MatchDebrief, (match_id, tid)) or MatchDebrief(match_id=match_id, team_id=tid)
    for f in ("worked", "change", "actions"):
        if f in body:
            note.__setattr__(f, str(body.get(f) or "")[:TEXT_MAX])
    note.updated_by = user.id if user else None
    note.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.merge(note)
    db.commit()
    return {"ok": True}


@router.get("/api/goals/metrics")
def goal_metrics():
    return catalog()


@router.get("/api/teams/{team_id}/goals")
def list_goals(request: Request, team_id: int, archived: bool = False, db: Session = Depends(get_session)):
    if db.get(Team, team_id) is None:
        raise HTTPException(404, "Équipe introuvable")
    q = select(TeamGoal).where(TeamGoal.team_id == team_id)
    q = q.where(TeamGoal.archived_at.is_not(None) if archived else TeamGoal.archived_at.is_(None))
    return [_goal_dict(db, g, request.app.state.maps) for g in db.scalars(q.order_by(TeamGoal.id.desc()))]


def _clean(body: dict, g: TeamGoal) -> None:
    if "metric" in body:
        if body["metric"] not in METRICS:
            raise HTTPException(400, "Mesure inconnue")
        g.metric = body["metric"]
    if "title" in body:
        t = str(body["title"] or "").strip()[:160]
        if not t:
            raise HTTPException(400, "Donnez un titre à l'axe de travail")
        g.title = t
    if "note" in body:
        g.note = str(body["note"] or "")[:TEXT_MAX]
    if "target" in body:
        t = body["target"]
        if t in (None, ""):
            g.target = None
        else:
            try:
                g.target = max(0.0, min(100.0, float(t)))
            except (TypeError, ValueError):
                raise HTTPException(400, "Objectif invalide (pourcentage)") from None


@router.post("/api/teams/{team_id}/goals")
def create_goal(request: Request, team_id: int, body: dict = Body(...), user: User | None = Depends(require_user),
                db: Session = Depends(get_session)):
    if db.get(Team, team_id) is None:
        raise HTTPException(404, "Équipe introuvable")
    if body.get("metric") not in METRICS:
        raise HTTPException(400, "Mesure inconnue")
    g = TeamGoal(team_id=team_id, metric=body["metric"], title=str(body.get("title") or METRICS[body["metric"]]["label"]))
    _clean({k: v for k, v in body.items() if k != "metric"}, g)
    src = body.get("source_match_id")
    if src and db.get(Match, int(src)) is not None:
        g.source_match_id = int(src)
    g.created_by = user.id if user else None
    g.created_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(g)
    db.commit()
    return _goal_dict(db, g, request.app.state.maps)


@router.patch("/api/goals/{goal_id}")
def update_goal(request: Request, goal_id: int, body: dict = Body(...), user: User | None = Depends(require_user),
                db: Session = Depends(get_session)):
    g = db.get(TeamGoal, goal_id)
    if g is None:
        raise HTTPException(404, "Axe de travail introuvable")
    _clean(body, g)
    if "archived" in body:
        g.archived_at = datetime.now(timezone.utc).replace(tzinfo=None) if body["archived"] else None
    db.commit()
    return _goal_dict(db, g, request.app.state.maps)


@router.delete("/api/goals/{goal_id}")
def delete_goal(goal_id: int, user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    g = db.get(TeamGoal, goal_id)
    if g is None:
        raise HTTPException(404, "Axe de travail introuvable")
    db.delete(g)
    db.commit()
    return {"ok": True}
