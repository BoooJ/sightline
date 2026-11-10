# backend/app/api/prep.py
"""Match Prep : templates à widgets (partagés ou privés) et rapports générés (adversaire + carte), imprimables."""
import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.api.scouting import _cache
from app.auth.core import current_user, require_user
from app.stats.brief import team_brief
from app.stats.prep import DEFAULT_TEMPLATE, WIDGETS, build_report, clean_widgets
from app.storage.models import PrepReport, PrepTemplate, User

router = APIRouter(prefix="/api/prep", tags=["prep"])


def _users(db: Session, ids: set[int]) -> dict[int, User]:
    return {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}


def _tpl(t: PrepTemplate, users: dict[int, User] | None = None) -> dict:
    u = (users or {}).get(t.created_by) if t.created_by else None
    return {"id": t.id, "name": t.name, "widgets": json.loads(t.widgets or "[]"), "shared": bool(t.shared), "created_by": t.created_by,
            "author": u.display_name if u else None, "updated_at": t.updated_at.isoformat() if t.updated_at else None}


def _rep(r: PrepReport, users: dict[int, User] | None = None, full: bool = False) -> dict:
    u = (users or {}).get(r.created_by) if r.created_by else None
    d = {"id": r.id, "team_id": r.team_id, "map": r.map_name, "template_id": r.template_id, "title": r.title, "notes": r.notes,
         "author": u.display_name if u else None, "created_at": r.created_at.isoformat() if r.created_at else None}
    if full:
        d["content"] = json.loads(r.content or "{}")
    else:
        c = json.loads(r.content or "{}")
        d["team"] = c.get("team")
        d["display_name"] = c.get("display_name")
        d["widgets"] = [w["type"] for w in c.get("widgets", [])]
    return d


def _visible(t: PrepTemplate, user: User | None) -> bool:
    return bool(t.shared) or user is None or t.created_by == user.id


def _ensure_default(db: Session) -> None:
    if db.scalar(select(PrepTemplate.id).limit(1)) is None:
        db.add(PrepTemplate(name="Rapport standard", widgets=json.dumps(DEFAULT_TEMPLATE), shared=True))
        db.commit()


@router.get("/widgets")
def widgets():
    return [{"type": k, "label": lbl, "help": h} for k, lbl, h in WIDGETS]


@router.get("/templates")
def list_templates(user: User | None = Depends(current_user), db: Session = Depends(get_session)):
    _ensure_default(db)
    rows = [t for t in db.scalars(select(PrepTemplate).order_by(PrepTemplate.id)) if _visible(t, user)]
    users = _users(db, {t.created_by for t in rows if t.created_by})
    return [_tpl(t, users) for t in rows]


@router.post("/templates")
def create_template(body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "Nom requis")
    try:
        widgets = clean_widgets(body.get("widgets", []))
    except ValueError as e:
        raise HTTPException(400, str(e))
    t = PrepTemplate(name=name[:120], widgets=json.dumps(widgets), shared=bool(body.get("shared", True)), created_by=user.id if user else None)
    db.add(t)
    db.commit()
    return _tpl(t)


def _get_tpl(db: Session, tid: int, user: User | None) -> PrepTemplate:
    t = db.get(PrepTemplate, tid)
    if t is None or not _visible(t, user):
        raise HTTPException(404, "Template introuvable")
    return t


@router.patch("/templates/{tid}")
def update_template(tid: int, body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    t = _get_tpl(db, tid, user)
    if "name" in body:
        if not str(body["name"]).strip():
            raise HTTPException(400, "Nom requis")
        t.name = str(body["name"]).strip()[:120]
    if "widgets" in body:
        try:
            t.widgets = json.dumps(clean_widgets(body["widgets"]))
        except ValueError as e:
            raise HTTPException(400, str(e))
    if "shared" in body:
        t.shared = bool(body["shared"])
    from sqlalchemy import func
    t.updated_at = func.now()
    db.commit()
    db.refresh(t)
    return _tpl(t)


@router.delete("/templates/{tid}")
def delete_template(tid: int, user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    db.delete(_get_tpl(db, tid, user))
    db.commit()
    return {"ok": True}


@router.get("/reports")
def list_reports(team: int | None = None, db: Session = Depends(get_session)):
    q = select(PrepReport).order_by(PrepReport.id.desc())
    if team:
        q = q.where(PrepReport.team_id == team)
    rows = list(db.scalars(q))
    users = _users(db, {r.created_by for r in rows if r.created_by})
    return [_rep(r, users) for r in rows]


@router.post("/reports")
def create_report(request: Request, body: dict = Body(...), user: User | None = Depends(require_user), db: Session = Depends(get_session)):
    """Génère un rapport (adversaire + carte) à partir d'un template : les données sont figées à la génération."""
    maps = request.app.state.maps
    team_id, map_name = int(body.get("team_id", 0)), str(body.get("map", ""))
    if map_name not in maps:
        raise HTTPException(400, "Carte inconnue")
    tpl = None
    if body.get("template_id"):
        tpl = _get_tpl(db, int(body["template_id"]), user)
        widgets = json.loads(tpl.widgets or "[]")
    else:
        try:
            widgets = clean_widgets(body.get("widgets", DEFAULT_TEMPLATE))
        except ValueError as e:
            raise HTTPException(400, str(e))
    content = build_report(db, maps, team_id, map_name, widgets,
                           brief_of=lambda m: _cache.get(db, ("brief", team_id, m), lambda: team_brief(db, maps, team_id, m)))
    if content is None:
        raise HTTPException(404, "Équipe introuvable")
    title = str(body.get("title") or f"{content['team']['name']} · {content['display_name']}")[:200]
    r = PrepReport(team_id=team_id, map_name=map_name, template_id=tpl.id if tpl else None, title=title, content=json.dumps(content),
                   notes=str(body.get("notes", "")), created_by=user.id if user else None)
    db.add(r)
    db.commit()
    from app.core.notify import notify
    notify(db, "prep_report", f"Rapport de préparation : {title}", f"{content['team']['name']} sur {content['display_name']}" + (f" · par {user.display_name}" if user else ""),
           f"/match-prep/{r.id}", bus=request.app.state.bus, settings=request.app.state.settings)
    return _rep(r, full=True)


@router.get("/reports/{rid}")
def get_report(rid: int, db: Session = Depends(get_session)):
    r = db.get(PrepReport, rid)
    if r is None:
        raise HTTPException(404, "Rapport introuvable")
    return _rep(r, _users(db, {r.created_by} if r.created_by else set()), full=True)


@router.patch("/reports/{rid}")
def update_report(rid: int, body: dict = Body(...), _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    r = db.get(PrepReport, rid)
    if r is None:
        raise HTTPException(404, "Rapport introuvable")
    if "title" in body and str(body["title"]).strip():
        r.title = str(body["title"]).strip()[:200]
    if "notes" in body:
        r.notes = str(body["notes"])[:8000]
    db.commit()
    return _rep(r, full=True)


@router.delete("/reports/{rid}")
def delete_report(rid: int, _: User | None = Depends(require_user), db: Session = Depends(get_session)):
    r = db.get(PrepReport, rid)
    if r is None:
        raise HTTPException(404, "Rapport introuvable")
    db.delete(r)
    db.commit()
    return {"ok": True}
