"""Évaluation du rapport de scouting rédigé par l'IA (réservé aux administrateurs ; voir app.ai.evals).

- POST /api/scouting/eval/checker : banc d'essai du contrôle sur les rapports enregistrés (sans coût) ;
- POST /api/scouting/eval/judge : calibrage du juge sur le dernier rapport d'une équipe (quelques centimes) ;
- POST /api/scouting/eval : campagne équipes × modèles en tâche de fond (coût : un rapport par ligne) ;
- GET  /api/scouting/eval : dernière campagne (résumé ; `full=true` pour les textes)."""
import asyncio
import json
import time

import anyio
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai import assistant, evals
from app.api.deps import get_session
from app.api.scouting import _facts
from app.auth.core import require_admin
from app.storage.models import ScoutingReport

router = APIRouter(prefix="/api/scouting/eval", tags=["eval"], dependencies=[Depends(require_admin)])
_state: dict = {"status": "idle"}
_tasks: set = set()


def _latest_reports(db: Session) -> list[ScoutingReport]:
    rows = db.scalars(select(ScoutingReport).where(ScoutingReport.status == "done").order_by(ScoutingReport.id.desc()))
    seen, out = set(), []
    for r in rows:
        if r.team_id not in seen:
            seen.add(r.team_id)
            out.append(r)
    return out


def _key(request: Request) -> str:
    c = assistant.config(request.app.state.settings.data_dir)
    if not c["key"] or c["provider"] != "anthropic":
        raise HTTPException(409, "L'évaluation demande une clé Anthropic (page Assistant).")
    return c["key"]


@router.post("/checker")
def checker(seed: int = 0, db: Session = Depends(get_session)):
    reps = []
    for r in _latest_reports(db):
        c = json.loads(r.content)
        if c.get("sections"):
            reps.append(({"sections": c["sections"]}, c.get("facts", {})))
    if not reps:
        raise HTTPException(409, "Aucun rapport enregistré : générez d'abord un rapport.")
    return {"reports": len(reps), **evals.checker_benchmark(reps, seed=seed)}


_judge_state: dict = {"status": "idle"}


@router.get("/judge")
def judge_result():
    return _judge_state


@router.post("/judge")
async def judge_calibration(request: Request, team_id: int, db: Session = Depends(get_session)):
    """Calibrage du juge en tâche de fond ; résultat : GET /api/scouting/eval/judge."""
    if _judge_state.get("status") == "running":
        return _judge_state
    key = _key(request)
    r = db.scalar(select(ScoutingReport).where(ScoutingReport.team_id == team_id, ScoutingReport.status == "done")
                  .order_by(ScoutingReport.id.desc()).limit(1))
    if r is None:
        raise HTTPException(404, "Pas de rapport pour cette équipe.")
    c = json.loads(r.content)
    _judge_state.clear()
    _judge_state.update({"status": "running", "team_id": team_id})

    async def run():
        try:
            res = await evals.judge_benchmark({"sections": c["sections"]}, c.get("facts", {}), evals.judge_llm(key))
            _judge_state.update({"status": "done", **res})
        except Exception as e:  # noqa: BLE001
            _judge_state.update({"status": "error", "error": str(e)[:500]})

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return _judge_state


def _reload(request: Request) -> None:
    """Après un redémarrage, l'état en mémoire est vide : on recharge la dernière campagne enregistrée."""
    if _state.get("status") in ("running", "done"):
        return
    files = sorted((request.app.state.settings.data_dir / "evals").glob("campagne-*.json"))
    if files:
        data = json.loads(files[-1].read_text(encoding="utf-8"))
        _state.clear()
        _state.update({"status": "done", "file": files[-1].name, "sheets": data["sheets"],
                       "result": {k: data[k] for k in ("runs", "models", "teams")}})


@router.get("")
def last(request: Request, full: bool = False):
    _reload(request)
    pub = {k: v for k, v in _state.items() if k != "sheets"}
    if full or _state.get("status") != "done":
        return pub
    return {**pub, "result": {**_state["result"], "runs": [{k: v for k, v in run.items() if k != "content"}
                                                           for run in _state["result"]["runs"]]}}


@router.post("/rejudge")
async def rejudge(request: Request):
    """Rejuge les rapports de la dernière campagne (juge modifié) sans les régénérer."""
    _reload(request)
    if _state.get("status") != "done":
        raise HTTPException(409, "Pas de campagne terminée.")
    key = _key(request)
    facts_by_team = {s["team"]["name"]: {f["id"]: f for f in s["facts"]} for s in _state["sheets"]}
    jl = evals.judge_llm(key)
    sem = asyncio.Semaphore(evals.JUDGE_PARALLEL)  # partagé : tous les rapports à la fois dépasseraient la limite de débit

    async def one(run):
        if not run.get("content"):
            return
        try:
            j = await evals.judge(run["content"], facts_by_team.get(run["team"], {}), jl, sem=sem)
            run.update({"judge_problems": j["count"], "judge_examples": j["problems"][:8], "judge_cost_usd": j["cost_usd"],
                        "judge_error": None})
        except Exception as e:  # noqa: BLE001 — une ligne en échec n'empêche pas les autres
            run.update({"judge_problems": None, "judge_error": str(e)[:200]})

    async def run_all():
        _state["rejudge"] = "running"
        await asyncio.gather(*(one(r) for r in _state["result"]["runs"]))
        _state["rejudge"] = "done"

    task = asyncio.create_task(run_all())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"rejudge": "running"}


@router.post("")
async def start(request: Request, body: dict = Body(...), db: Session = Depends(get_session)):
    """{"teams": [id…], "models": ["claude-haiku-5-5", …], "judge": true}"""
    if _state.get("status") == "running":
        return _state
    key = _key(request)
    models = [m for m in body.get("models", []) if m in assistant.MODELS and m.startswith("claude")]
    teams = [int(t) for t in body.get("teams", [])][:5]
    if not models or not teams:
        raise HTTPException(400, "Indiquez des équipes et des modèles Claude.")
    sheets = []
    for t in teams:
        s = await anyio.to_thread.run_sync(lambda t=t: _facts(request, db, t))
        if s is None:
            raise HTTPException(404, f"Équipe {t} introuvable")
        sheets.append(s)
    out_dir = request.app.state.settings.data_dir / "evals"
    _state.clear()
    _state.update({"status": "running", "started": time.time(), "models": models, "teams": [s["team"]["name"] for s in sheets]})

    async def run():
        try:
            res = await evals.campaign(sheets, models, key, with_judge=bool(body.get("judge", True)))
            out_dir.mkdir(parents=True, exist_ok=True)
            path = out_dir / f"campagne-{time.strftime('%Y%m%d-%H%M%S')}.json"
            path.write_text(json.dumps({"sheets": sheets, **res}, ensure_ascii=False), encoding="utf-8")
            _state.update({"status": "done", "result": res, "file": path.name, "sheets": sheets,
                           "duration_s": round(time.time() - _state["started"])})
        except Exception as e:  # noqa: BLE001
            _state.update({"status": "error", "error": str(e)[:500]})

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return _state
