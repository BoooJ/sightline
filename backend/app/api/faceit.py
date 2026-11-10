"""Scouting FACEIT : équipes ESEA (ou autres championnats) absentes de HLTV.

La fiche vient de l'API Data de FACEIT ; l'analyse détaillée vient des démos, importées d'un clic (API Downloads) ou à
la main, puis rattachées à l'équipe locale du même nom (voir app.faceit.link)."""
import asyncio
import json
import os
import re
import secrets
from contextlib import contextmanager

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import demos as demos_api
from app.api.deps import get_service, get_session, get_settings
from app.auth.core import current_user, require_owner
from app.core.config import Settings
from app.core.secrets import read_secrets, write_secrets
from app.faceit import scout
from app.faceit.client import FaceitClient, FaceitError, api_key, save_key
from app.faceit.link import link_all, local_team_id, match_demos
from app.ingest import remote
from app.ingest.service import ImportService
from app.stats.cache import LibraryCache
from app.storage.models import FaceitTeam, Player, User

router = APIRouter(prefix="/api/faceit", tags=["faceit"])
_KEY = re.compile(r"[A-Za-z0-9-]{20,80}")


@contextmanager
def _client(settings: Settings):
    key, _ = api_key(settings.data_dir)
    if not key:
        raise HTTPException(409, "Clé d'API FACEIT manquante : un administrateur doit l'ajouter (developers.faceit.com).")
    c = FaceitClient(key, settings.cache_dir / "faceit")
    try:
        yield c
    except FaceitError as e:
        raise HTTPException(e.status, str(e)) from e
    finally:
        c.close()


def _downloads(settings: Settings) -> bool:
    """Accès à l'API Downloads accordé par FACEIT (sur demande, souvent refusé aux projets non commerciaux) : sans lui,
    les démos s'importent en collant le lien du bouton « Télécharger la démo » de la page du match."""
    return os.environ.get("SKYBOX_FACEIT_DOWNLOADS") == "1" or bool(read_secrets(settings.data_dir).get("faceit_downloads"))


def _status(settings: Settings, can_configure: bool) -> dict:
    key, source = api_key(settings.data_dir)
    return {"configured": bool(key), "source": source, "can_configure": can_configure, "downloads": _downloads(settings)}


@router.get("/status")
def status(settings: Settings = Depends(get_settings), user: User | None = Depends(current_user)):
    return _status(settings, user is None or user.role == "owner")


@router.put("/config")
def set_config(body: dict = Body(...), settings: Settings = Depends(get_settings), _: User | None = Depends(require_owner)):
    """{"api_key": "..."}, {"clear_key": true} ou {"downloads": true|false}. La clé n'est jamais renvoyée."""
    if "downloads" in body:
        sec = read_secrets(settings.data_dir)
        sec["faceit_downloads"] = bool(body["downloads"])
        write_secrets(settings.data_dir, sec)
    elif body.get("clear_key"):
        save_key(settings.data_dir, None)
    else:
        key = str(body.get("api_key") or "").strip()
        if not _KEY.fullmatch(key):
            raise HTTPException(400, "Clé d'API FACEIT invalide : collez la « Server side API key » de votre application")
        c = FaceitClient(key, settings.cache_dir / "faceit")
        try:
            c.get("/games/cs2", ttl=0)
        except FaceitError as e:
            if e.status != 503:
                raise HTTPException(400, "Clé refusée par FACEIT") from e
        finally:
            c.close()
        save_key(settings.data_dir, key)
    return _status(settings, True)


@router.get("/search")
def search(q: str, settings: Settings = Depends(get_settings)):
    with _client(settings) as c:
        return scout.search(c, q)[:20]


@router.get("/teams")
def tracked(db: Session = Depends(get_session)):
    return [{"team_id": t.team_id, "name": t.name, "avatar": t.avatar, "local_team_id": local_team_id(db, t.name),
             "updated_at": t.updated_at.isoformat() if t.updated_at else None}
            for t in db.scalars(select(FaceitTeam).order_by(FaceitTeam.updated_at.desc()))]


@router.get("/teams/{team_id}")
def team(team_id: str, request: Request, scope: str = "esea", db: Session = Depends(get_session),
         settings: Settings = Depends(get_settings)):
    """Fiche de scouting de l'équipe. La consulter la suit : ses démos sont rattachées à elle à l'import."""
    if not re.fullmatch(scout.UUID, team_id, re.IGNORECASE):
        raise HTTPException(400, "Identifiant d'équipe FACEIT invalide")
    maps = request.app.state.maps
    with _client(settings) as c:
        data = scout.team_overview(c, team_id, "all" if scope == "all" else "esea",
                                   map_names={m.display_name: m.name for m in maps.values()},
                                   active_maps=[m.name for m in maps.values() if m.active_duty])
    # joueurs de l'équipe (roster actuel et joueurs vus dans ses matchs) → rattachement des démos
    steamids = {p["steamid"] for p in data["roster"] if p["steamid"]}
    steamids |= {s for m in data["matches"] for s in m.pop("steamids")}
    ft = db.get(FaceitTeam, team_id)
    if ft is None:
        ft = FaceitTeam(team_id=team_id, name=data["team"]["name"])
        db.add(ft)
    old = (ft.name, set(json.loads(ft.steamids or "[]")))
    ft.name, ft.avatar = data["team"]["name"], data["team"]["avatar"]
    ft.steamids = json.dumps(sorted(old[1] | steamids))
    db.commit()
    if old != (ft.name, set(json.loads(ft.steamids))) and link_all(db):
        LibraryCache.bump()  # des matchs ont changé d'équipe : stats et scouting à recalculer
    demos = match_demos(db, [m["match_id"] for m in data["matches"]])
    for m in data["matches"]:
        m["imported"] = demos.get(m["match_id"], [])
    known = set(db.scalars(select(Player.steamid).where(Player.steamid.in_([p["steamid"] for p in data["roster"] if p["steamid"]]))))
    for p in data["roster"]:
        p["in_library"] = p["steamid"] in known
    data["local_team_id"] = local_team_id(db, ft.name)
    data["map_names"] = {m.name: m.display_name for m in maps.values()}
    return data


@router.delete("/teams/{team_id}")
def untrack(team_id: str, db: Session = Depends(get_session)):
    ft = db.get(FaceitTeam, team_id)
    if ft is not None:
        db.delete(ft)
        db.commit()
    return {"ok": True}


@router.post("/matches/{match_id}/import")
async def import_match(match_id: str, body: dict = Body(default={}), svc: ImportService = Depends(get_service),
                       db: Session = Depends(get_session), settings: Settings = Depends(get_settings)):
    """Importe les démos d'un match FACEIT : {"url": lien du bouton « Télécharger la démo »}, ou sans lien via l'API
    Downloads (une démo par carte). Suivi : GET /api/demos/remote."""
    if not scout.MATCH_ID.fullmatch(match_id):
        raise HTTPException(400, "Identifiant de match FACEIT invalide")
    url = str(body.get("url") or "").strip()
    if url:
        try:
            await asyncio.to_thread(remote.check_url, url)
        except remote.RemoteError as e:
            raise HTTPException(400, str(e)) from e
        if remote.FACEIT_ROOM.search(url):
            raise HTTPException(400, "C'est le lien de la page du match : copiez plutôt le lien du bouton « Télécharger la démo » (clic droit → Copier l'adresse du lien).")
        return [demos_api.start_download(remote.Download(id=secrets.token_hex(6), url=url, faceit_match=match_id), svc, settings)]
    with _client(settings) as c:
        detail = c.get(f"/matches/{match_id}", ttl=None)
    n = len(detail.get("demo_url") or [])
    if not n:
        raise HTTPException(409, "FACEIT ne propose pas de démo pour ce match.")
    done = {d["demo_id"] for d in match_demos(db, [match_id]).get(match_id, [])}
    if len(done) >= n:
        raise HTTPException(409, "Démos déjà importées.")
    return [demos_api.start_download(remote.Download(id=secrets.token_hex(6), url=scout.room_url(match_id),
                                                     demo_index=i, faceit_match=match_id), svc, settings)
            for i in range(len(done), n)]
