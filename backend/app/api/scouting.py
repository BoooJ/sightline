# backend/app/api/scouting.py
import asyncio
import json

import anyio
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai import assistant
from app.ai import coach as coach_ai
from app.ai import evals
from app.ai import report as ai_report
from app.api.deps import big_json, get_session
from app.auth.core import current_user, require_admin
from app.stats.brief import team_brief
from app.stats.cache import LibraryCache
from app.stats.facts import team_facts
from app.stats.playbook import team_playbook
from app.stats.learn import position_study
from app.stats.role_profile import role_profiles
from app.stats.routine import player_routine
from app.stats.story import player_story
from app.stats.timings import team_timings
from app.stats.veto import veto_data
from app.stats.scouting import scouting_teams, team_map_utility, team_report
from app.storage.models import CoachNote, ScoutingReport, User

router = APIRouter(prefix="/api/scouting", tags=["scouting"])
_cache = LibraryCache(32)


@router.get("/teams")
def teams(db: Session = Depends(get_session)):
    return scouting_teams(db)


@router.get("/teams/{team_id}")
def report(team_id: int, db: Session = Depends(get_session)):
    r = _cache.get(db, ("report", team_id), lambda: team_report(db, team_id))
    if r is None:
        raise HTTPException(404, "Équipe introuvable")
    from app.storage.models import FaceitTeam  # fiche FACEIT de la même équipe, si elle est suivie
    ft = db.scalar(select(FaceitTeam).where(FaceitTeam.name == r["team"]["name"]))
    return {**r, "faceit_team_id": ft.team_id if ft else None}


@router.get("/teams/{team_id}/brief")
def brief(request: Request, team_id: int, map: str, armed: bool = False, db: Session = Depends(get_session)):
    """Brief d'une carte lisible par un débutant : pistols, rounds après pistol, premier gun round, qui joue où,
    utilitaires par lieu, phrases « à retenir » et pistes pour les contrer, chaque chiffre avec sa fiabilité.
    `armed=true` : seulement les rounds armés contre armés (full / force des deux côtés)."""
    if map not in request.app.state.maps:
        raise HTTPException(404, "Carte inconnue")
    key = ("brief", team_id, map) if not armed else ("brief", team_id, map, "armed")
    return _cache.get(db, key, lambda: team_brief(db, request.app.state.maps, team_id, map, armed))


@router.get("/teams/{team_id}/utility")
def utility(team_id: int, map: str, db: Session = Depends(get_session)):
    return _cache.get(db, ("utility", team_id, map), lambda: team_map_utility(db, team_id, map))


@router.get("/teams/{team_id}/playbook")
def playbook(request: Request, team_id: int, map: str, db: Session = Depends(get_session)):
    return _cache.get(db, ("playbook", team_id, map), lambda: team_playbook(db, request.app.state.maps, team_id, map))


@router.get("/veto")
def veto(request: Request, team_a: int, team_b: int, maps: str | None = None, db: Session = Depends(get_session)):
    """Force des deux équipes par carte ; `maps` = pool (CSV), par défaut toutes les cartes connues."""
    pool = [m for m in (maps.split(",") if maps else request.app.state.maps.keys()) if m]
    d = veto_data(db, team_a, team_b, pool)
    if d is None:
        raise HTTPException(404, "Équipe introuvable")
    return d


def tactic_round_ids(pb: dict, tactic: str) -> tuple[set[int], str]:
    """Rounds d'une tactique du playbook (« t:execute », « t:execute:B », « t:default::exec », « ct:<placement> ») et
    camp concerné."""
    kind, _, rest = tactic.partition(":")
    if kind == "t":
        cat, site, sub = (rest.split(":") + ["", ""])[:3]   # « t:<cat> », « t:<cat>:<site> », « t:default::<sous-type> »
        return {x["round_id"] for x in pb["t"]["list"] if x["category"] == cat
                and (site in ("", "*") or (x["site"] or "none") == site)
                and (not sub or x.get("default_kind") == sub)}, "T"
    if kind == "ct":
        return {x["round_id"] for x in pb["ct"]["list"] if x["setup"] == rest}, "CT"
    raise HTTPException(400, "Tactique inconnue")


@router.get("/teams/{team_id}/timings")
def timings(request: Request, team_id: int, map: str, side: str = "T", tactic: str | None = None,
            db: Session = Depends(get_session)):
    """Carte des timings : arrivée de l'équipe dans chaque zone et positions toutes les 5 s, par camp ou par tactique."""
    side = side.upper()
    if side not in ("CT", "T") or map not in request.app.state.maps:
        raise HTTPException(400, "Camp ou carte invalide")
    ids = None
    if tactic:
        ids, side = tactic_round_ids(playbook(request, team_id, map, db), tactic)
    key = ("timings", team_id, map, side, tactic)
    return _cache.get(db, key, lambda: team_timings(db, request.app.state.maps, team_id, map, side, ids))


@router.get("/learn")
def learn(request: Request, map: str, side: str, place: str | None = None, at: int = 20, db: Session = Depends(get_session)):
    """Apprendre un poste : postes de la carte pour un camp, ou détail des rounds joués à `place`."""
    side = side.upper()
    if side not in ("CT", "T") or map not in request.app.state.maps or not 5 <= at <= 60:
        raise HTTPException(400, "Paramètres invalides")
    return _cache.get(db, ("learn", map, side, place, at),
                      lambda: position_study(db, request.app.state.maps, map, side, at, place))


@router.get("/roles")
def roles(request: Request, map: str, side: str, db: Session = Depends(get_session)):
    """Profils de rôle des joueurs sur une carte et un camp : indicateurs, score par rôle, références par rôle."""
    side = side.upper()
    if side not in ("CT", "T") or map not in request.app.state.maps:
        raise HTTPException(400, "Paramètres invalides")
    return _cache.get(db, ("roles", map, side), lambda: role_profiles(db, request.app.state.maps, map, side))


@router.get("/story")
def story(request: Request, match: int, steamid: str, db: Session = Depends(get_session)):
    """Histoire de chaque round d'un joueur dans une démo : étapes (achat, placement, utilitaires, kills, mort…) et trajet."""
    d = _cache.get(db, ("story", match, steamid), lambda: player_story(db, request.app.state.maps, match, steamid))
    if d is None:
        raise HTTPException(404, "Démo ou joueur introuvable")
    return big_json(d)  # réponse volumineuse : sérialisée directement


@router.get("/routine")
def routine(request: Request, match: int, steamid: str, side: str = "CT", scope: str = "match", armed: bool = True,
            db: Session = Depends(get_session)):
    """Routine d'un joueur sur ses rounds armés : achat, postes à 0:10/0:20/0:40/1:00, grenades et leur moment,
    rotations, lieux de mort. `scope=map` : toutes ses démos de cette carte."""
    side = "T" if side == "T" else "CT"
    maps = request.app.state.maps
    d = _cache.get(db, ("routine", match, steamid, side, scope, armed), lambda: player_routine(
        db, maps, steamid, match, side, "map" if scope == "map" else "match", armed,
        story_of=lambda mid: _cache.get(db, ("story", mid, steamid), lambda: player_story(db, maps, mid, steamid))))
    if d is None:
        raise HTTPException(404, "Démo introuvable")
    return d


COACH_MODEL = "claude-haiku-5-5"  # explications courtes : le modèle économique suffit (≈ 1 centime)
COACH_VERSION = "v4"  # à changer quand les faits ou la consigne du coach changent : les anciens textes sont réécrits


@router.post("/coach")
async def coach(request: Request, body: dict = Body(...), db: Session = Depends(get_session),
                user: User | None = Depends(current_user)):
    """L'IA comme coach : {"kind": "round", "match", "steamid", "round"} ou {"kind": "routine", "match", "steamid",
    "side", "scope"}. Gardé en cache ; `regenerate` (administrateurs) pour rédiger à nouveau."""
    kind = "routine" if body.get("kind") == "routine" else "round"
    match, steamid = int(body.get("match", 0)), str(body.get("steamid", ""))
    side = "T" if body.get("side") == "T" else "CT"
    scope = "map" if body.get("scope") == "map" else "match"
    key = f"{COACH_VERSION}:{kind}:{match}:{steamid}:" + (f"r{int(body.get('round', 0))}" if kind == "round" else f"{side}:{scope}")
    note = db.get(CoachNote, key)
    if note is not None and not (body.get("regenerate") and (user is None or user.role in ("owner", "admin"))):
        return {**json.loads(note.content), "model": note.model, "cost_usd": note.cost_usd, "cached": True}
    data_dir = request.app.state.settings.data_dir
    akey = assistant.key_for(data_dir, "anthropic")
    if akey:
        model, llm_key = COACH_MODEL, akey
    else:
        c = assistant.config(data_dir)
        model, llm_key = c["model"], c["key"]
    if not llm_key:
        raise HTTPException(409, "Assistant IA non configuré : ajoutez une clé API (page Assistant).")
    maps = request.app.state.maps
    st = await anyio.to_thread.run_sync(lambda: _cache.get(db, ("story", match, steamid), lambda: player_story(db, maps, match, steamid)))
    if st is None:
        raise HTTPException(404, "Démo ou joueur introuvable")
    if kind == "round":
        rnd = next((r for r in st["rounds"] if r["number"] == int(body.get("round", 0))), None)
        if rnd is None:
            raise HTTPException(404, "Round introuvable")
        facts = coach_ai.round_facts(st, rnd)
        header = f"Joueur suivi : {st['name']}. Carte : {st['map']}."
    else:
        rt = await anyio.to_thread.run_sync(lambda: player_routine(
            db, maps, steamid, match, side, scope, True,
            story_of=lambda mid: _cache.get(db, ("story", mid, steamid), lambda: player_story(db, maps, mid, steamid))))
        if rt is None or not rt["rounds"]:
            raise HTTPException(409, "Pas de round armé dans ce camp pour écrire un guide.")
        facts = coach_ai.routine_facts(rt)
        header = f"Joueur étudié : {rt['name']}. Carte : {rt['map']}."
    res = await coach_ai.write(kind, facts, header, ai_report.llm_for(llm_key, model))
    content = {"kind": kind, "blocks": res["blocks"], "facts": res["facts"], "checks": res["checks"]}
    cost = ai_report.cost_of(model, res["tokens_in"], res["tokens_out"])
    db.merge(CoachNote(key=key, kind=kind, content=json.dumps(content, ensure_ascii=False), model=model, cost_usd=cost))
    db.commit()
    return {**content, "model": model, "cost_usd": cost, "cached": False}


# ------------------------------------------------------------------------- fiche de faits et rapport rédigé par l'IA
def _facts(request: Request, db: Session, team_id: int) -> dict | None:
    maps = request.app.state.maps
    return team_facts(db, maps, team_id,
                      brief_of=lambda m: _cache.get(db, ("brief", team_id, m), lambda: team_brief(db, maps, team_id, m)))


@router.get("/teams/{team_id}/facts")
def facts(request: Request, team_id: int, db: Session = Depends(get_session)):
    """Tous les chiffres du scouting de l'équipe, chacun avec un identifiant (source unique du rapport de l'IA)."""
    sheet = _facts(request, db, team_id)
    if sheet is None:
        raise HTTPException(404, "Équipe introuvable")
    return sheet


def _report_dict(r: ScoutingReport) -> dict:
    return {"id": r.id, "team_id": r.team_id, "status": r.status, "model": r.model, "error": r.error,
            "content": json.loads(r.content or "{}"), "checks": json.loads(r.checks or "{}"),
            "tokens_in": r.tokens_in, "tokens_out": r.tokens_out, "cost_usd": r.cost_usd, "latency_s": r.latency_s,
            "created_at": r.created_at.isoformat() if r.created_at else None}


@router.get("/teams/{team_id}/report")
def last_report(team_id: int, db: Session = Depends(get_session)):
    r = db.scalar(select(ScoutingReport).where(ScoutingReport.team_id == team_id).order_by(ScoutingReport.id.desc()).limit(1))
    return _report_dict(r) if r else None


_jobs: set = set()  # référence gardée : une tâche asyncio sans référence peut être collectée


@router.post("/teams/{team_id}/report")
async def make_report(request: Request, team_id: int, model: str | None = None, db: Session = Depends(get_session),
                      user: User | None = Depends(require_admin)):
    """Lance la rédaction (une à deux minutes) ; suivi : GET …/report (status running → done | error).
    `model` : modèle de rédaction (sinon celui de l'assistant). Si une clé Anthropic existe, le juge (Claude Haiku)
    relit ensuite le rapport et ses remarques sont attachées aux blocs (« à vérifier »), sans rien retirer."""
    running = db.scalar(select(ScoutingReport).where(ScoutingReport.team_id == team_id, ScoutingReport.status == "running"))
    if running is not None:
        return _report_dict(running)
    data_dir = request.app.state.settings.data_dir
    c = assistant.config(data_dir)
    if model:
        if model not in assistant.MODELS:
            raise HTTPException(400, "Modèle inconnu")
        c = {**c, "model": model, "key": assistant.key_for(data_dir, assistant.provider_of(model))}
    if not c["key"]:
        raise HTTPException(409, "Assistant IA non configuré pour ce modèle : ajoutez une clé API (page Assistant).")
    judge_key = assistant.key_for(data_dir, "anthropic")
    sheet = await anyio.to_thread.run_sync(lambda: _facts(request, db, team_id))
    if sheet is None:
        raise HTTPException(404, "Équipe introuvable")
    row = ScoutingReport(team_id=team_id, status="running", model=c["model"], created_by=user.id if user else None)
    db.add(row)
    db.commit()
    rid, sf = row.id, request.app.state.session_factory
    llm = ai_report.llm_for(c["key"], c["model"])

    async def run():
        try:
            res = await ai_report.generate(sheet, llm)
            judge_cost = None
            if judge_key:  # relecture par le juge : remarques attachées aux blocs, rien n'est retiré
                try:
                    j = await evals.judge({"sections": res["sections"]}, {f["id"]: f for f in sheet["facts"]},
                                          evals.judge_llm(judge_key))
                    for p in j["problems"]:
                        sec = next((x for x in res["sections"] if x["key"] == p["section"]), None)
                        if sec and 0 <= p.get("block", -1) < len(sec["blocks"]):
                            sec["blocks"][p["block"]].setdefault("alerts", []).append(
                                {k: p[k] for k in ("claim", "verdict", "reason") if k in p})
                    res["checks"]["judge_alerts"] = j["count"]
                    judge_cost = j["cost_usd"]
                except Exception:  # noqa: BLE001 — le juge est un plus, pas une condition
                    res["checks"]["judge_alerts"] = None
            with sf() as s:
                r = s.get(ScoutingReport, rid)
                r.status = "done"
                r.content = json.dumps({"sections": res["sections"], "facts": res["facts"], "team": sheet["team"]}, ensure_ascii=False)
                r.checks = json.dumps(res["checks"], ensure_ascii=False)
                r.tokens_in, r.tokens_out, r.latency_s = res["tokens_in"], res["tokens_out"], res["latency_s"]
                cost = ai_report.cost_of(r.model, r.tokens_in, r.tokens_out)
                r.cost_usd = round(cost + (judge_cost or 0), 4) if cost is not None else None
                s.commit()
        except Exception as e:  # noqa: BLE001 — affiché sur la page
            with sf() as s:
                r = s.get(ScoutingReport, rid)
                r.status, r.error = "error", f"Rédaction impossible : {e}"
                s.commit()

    task = asyncio.create_task(run())
    _jobs.add(task)
    task.add_done_callback(_jobs.discard)
    return _report_dict(row)
